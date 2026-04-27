import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

// ─── Utilities ────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
    ]);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileEntry {
    relativePath: string;
    fullPath: string;
}

// ─── Ignore Engine ────────────────────────────────────────────────────────────

class IgnoreEngine {
    private rules: { regex: RegExp; negate: boolean }[] = [];

    constructor(patterns: string[]) {
        for (let p of patterns) {
            p = p.trim();
            if (!p || p.startsWith('#')) { continue; }

            let negate = false;
            if (p.startsWith('!')) {
                negate = true;
                p = p.substring(1);
            }

            let regexStr = p
                .replace(/\./g, '\\.')
                .replace(/\*\*/g, '.*')
                .replace(/\*/g, '[^/]*')
                .replace(/\?/g, '[^/]');

            regexStr = (p.startsWith('/') ? '^' + regexStr.substring(1) : '(^|/)' + regexStr) + '($|/)';

            this.rules.push({ regex: new RegExp(regexStr), negate });
        }
    }

    public isIgnored(relativePath: string): boolean {
        let ignored = false;
        for (const rule of this.rules) {
            if (rule.regex.test(relativePath)) {
                ignored = !rule.negate;
            }
        }
        return ignored;
    }
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'project-snapshot.generate',
            async (uri: vscode.Uri, selectedUris: vscode.Uri[]) => {
                const targets = selectedUris?.length > 0 ? selectedUris : uri ? [uri] : [];
                await generateSnapshot(targets);
            }
        )
    );
}

// ─── Main Snapshot Logic ──────────────────────────────────────────────────────

async function generateSnapshot(targets: vscode.Uri[]) {
    if (!targets || targets.length === 0) {
        if (vscode.workspace.workspaceFolders?.length) {
            targets = [vscode.workspace.workspaceFolders[0].uri];
        } else {
            vscode.window.showErrorMessage('No folder selected or workspace opened');
            return;
        }
    }

    const config = vscode.workspace.getConfiguration('projectSnapshot');
    const globalIgnores   = config.get<string[]>('globalIgnores') || [];
    const includedExts    = config.get<string[]>('includedExtensions') || ['*'];
    const ignoreEngine    = new IgnoreEngine(globalIgnores);
    const includeAllExts  = includedExts.includes('*');
    const allowedExts     = new Set(includedExts.map(e => e.toLowerCase()));

    const workspaceRoot = vscode.workspace.getWorkspaceFolder(targets[0])?.uri.fsPath
        ?? path.dirname(targets[0].fsPath);

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Generating Snapshot', cancellable: false },
        async (progress) => {
            try {
                await withTimeout((async () => {
                    progress.report({ increment: 10, message: 'Scanning...' });

                    // ── Separate dirs from files upfront ──────────────────────
                    const dirTargets:  vscode.Uri[] = [];
                    const fileTargets: vscode.Uri[] = [];

                    await Promise.all(targets.map(async (t) => {
                        const stat = await fs.promises.stat(t.fsPath);
                        (stat.isDirectory() ? dirTargets : fileTargets).push(t);
                    }));

                    // ── Single-pass scan: tree + file collection together ─────
                    const treeParts: string[] = [];
                    const allFiles:  FileEntry[] = [];

                    // Lone files (not inside a selected dir)
                    for (const t of fileTargets) {
                        const rel = path.relative(workspaceRoot, t.fsPath).replace(/\\/g, '/');
                        if (!ignoreEngine.isIgnored(rel)) {
                            treeParts.push(`${rel}\n`);
                            allFiles.push({ relativePath: rel, fullPath: t.fsPath });
                        }
                    }

                    // Directories — scan in parallel
                    const dirResults = await Promise.all(
                        dirTargets.map(t =>
                            scanDirectory(t.fsPath, workspaceRoot, ignoreEngine, includeAllExts, allowedExts)
                        )
                    );

                    for (const r of dirResults) {
                        treeParts.push(r.tree);
                        allFiles.push(...r.files);
                    }

                    // Deduplicate by fullPath
                    const uniqueFiles = Array.from(
                        new Map(allFiles.map(f => [f.fullPath, f])).values()
                    );

                    progress.report({ increment: 30, message: 'Reading files...' });
                    const fileContents = await generateFileContents(uniqueFiles, progress);

                    progress.report({ increment: 10, message: 'Writing...' });
                    const snapshot =
                        '==================== PROJECT DIRECTORY STRUCTURE ====================\n\n' +
                        treeParts.join('') +
                        '\n\n==================== FILE CONTENTS ====================\n\n' +
                        fileContents;

                    const rootFolderName = path.basename(workspaceRoot);
                    const tempFilePath   = path.join(os.tmpdir(), `${rootFolderName}-schema.md`);
                    await fs.promises.writeFile(tempFilePath, snapshot, 'utf-8');

                    // ── Clipboard ─────────────────────────────────────────────
                    let copyMethod = 'File';
                    try {
                        await copyNativeFileToClipboard(tempFilePath);
                    } catch {
                        await vscode.env.clipboard.writeText(tempFilePath);
                        copyMethod = 'Path';
                    }

                    const successMsg = `${copyMethod} copied! (${uniqueFiles.length} files)`;
                    vscode.window.setStatusBarMessage(`$(check) ${successMsg}`, 10000);
                    vscode.window.showInformationMessage(successMsg, 'Reveal').then(sel => {
                        if (sel === 'Reveal') {
                            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(tempFilePath));
                        }
                    });

                })(), 15000, 'Generation timed out (15s limit reached)');

            } catch (error) {
                vscode.window.showErrorMessage(
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
    );
}

// ─── Single-Pass Directory Scanner ───────────────────────────────────────────

async function scanDirectory(
    dirPath:       string,
    rootPath:      string,
    ignoreEngine:  IgnoreEngine,
    includeAllExts: boolean,
    allowedExts:   Set<string>
): Promise<{ tree: string; files: FileEntry[] }> {
    const treeParts: string[] = [];
    const files:     FileEntry[] = [];

    const relStart = path.relative(rootPath, dirPath).replace(/\\/g, '/');
    treeParts.push(`${relStart === '' ? path.basename(dirPath) : relStart}/\n`);

    async function walk(dir: string, level: number): Promise<void> {
        const entries  = await fs.promises.readdir(dir, { withFileTypes: true });
        const indent   = '    '.repeat(level);

        const valid = entries.filter((e: fs.Dirent) => {
            const rel = path.relative(rootPath, path.join(dir, e.name)).replace(/\\/g, '/');
            return !ignoreEngine.isIgnored(e.isDirectory() ? rel + '/' : rel);
        });

        const dirs  = valid.filter((e: fs.Dirent) => e.isDirectory() ).sort((a, b) => a.name.localeCompare(b.name));
        const fents = valid.filter((e: fs.Dirent) => e.isFile()      ).sort((a, b) => a.name.localeCompare(b.name));

        // Subdirectories — recurse in parallel
        await Promise.all(dirs.map(async (e) => {
            treeParts.push(`${indent}${e.name}/\n`);
            await walk(path.join(dir, e.name), level + 1);
        }));

        for (const e of fents) {
            treeParts.push(`${indent}${e.name}\n`);
            const fullPath    = path.join(dir, e.name);
            const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');
            const ext         = path.extname(e.name).toLowerCase();
            if (includeAllExts || allowedExts.has(ext)) {
                files.push({ relativePath, fullPath });
            }
        }
    }

    await walk(dirPath, 1);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return { tree: treeParts.join(''), files };
}

// ─── File Content Reader (batched parallel) ───────────────────────────────────

const READ_CONCURRENCY = 20;

async function generateFileContents(
    files:    FileEntry[],
    progress: vscode.Progress<{ increment?: number; message?: string }>
): Promise<string> {
    const results: string[] = new Array(files.length);
    const total = files.length;

    for (let i = 0; i < total; i += READ_CONCURRENCY) {
        const batch = files.slice(i, i + READ_CONCURRENCY);
        await Promise.all(batch.map(async (file, j) => {
            const idx = i + j;
            try {
                const content = await fs.promises.readFile(file.fullPath, 'utf-8');
                const lang    = path.extname(file.relativePath).substring(1).toLowerCase() || 'text';
                results[idx]  =
                    `<file path="${file.relativePath}">\n` +
                    `\`\`\`${lang}\n` +
                    content.trim() +
                    `\n\`\`\`\n` +
                    `</file>\n\n`;
            } catch (error) {
                results[idx] =
                    `<file path="${file.relativePath}">\n` +
                    `Error reading file: ${error instanceof Error ? error.message : String(error)}\n` +
                    `</file>\n\n`;
            }
        }));

        const done = Math.min(i + READ_CONCURRENCY, total);
        progress.report({ increment: Math.floor((READ_CONCURRENCY / total) * 50), message: `Reading files... (${done}/${total})` });
    }

    return results.join('');
}

// ─── Native Clipboard ─────────────────────────────────────────────────────────

function copyNativeFileToClipboard(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const platform = os.platform();
        let command: string;

        if (platform === 'win32') {
            // Escape single quotes for PowerShell string literal
            const escaped = filePath.replace(/'/g, "''");
            command = `powershell.exe -STA -NoProfile -NonInteractive -Command "Get-Item -LiteralPath '${escaped}' | Set-Clipboard"`;
        } else if (platform === 'darwin') {
            // Escape backslashes and double quotes for AppleScript
            const escaped = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            command = `osascript -e 'set the clipboard to POSIX file "${escaped}"'`;
        } else {
            return reject(new Error('Native file copy not supported on this OS'));
        }

        exec(command, (error) => error ? reject(error) : resolve());
    });
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate() {}