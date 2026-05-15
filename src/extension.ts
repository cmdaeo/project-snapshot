import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import ignore from 'ignore';

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

interface PortProcess {
    port: number;
    pid: number;
    name: string;
}

// ─── Settings Provider (Sidebar UI) ───────────────────────────────────────────

class SnapshotConfigProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (element) { return Promise.resolve([]); }

        const config = vscode.workspace.getConfiguration('projectSnapshot');
        const includeTree = config.get<boolean>('includeDirectoryTree') ?? true;
        const includeContents = config.get<boolean>('includeFileContents') ?? true;

        const generateItem = new vscode.TreeItem('Generate Snapshot', vscode.TreeItemCollapsibleState.None);
        generateItem.iconPath = new vscode.ThemeIcon('play');
        generateItem.command = { command: 'project-snapshot.generate', title: 'Generate' };

        const toggleTreeItem = new vscode.TreeItem(`Include Tree: ${includeTree ? 'ON' : 'OFF'}`, vscode.TreeItemCollapsibleState.None);
        toggleTreeItem.iconPath = new vscode.ThemeIcon(includeTree ? 'check' : 'close');
        toggleTreeItem.command = { command: 'project-snapshot.toggleTree', title: 'Toggle Tree' };

        const toggleContentsItem = new vscode.TreeItem(`Include Contents: ${includeContents ? 'ON' : 'OFF'}`, vscode.TreeItemCollapsibleState.None);
        toggleContentsItem.iconPath = new vscode.ThemeIcon(includeContents ? 'check' : 'close');
        toggleContentsItem.command = { command: 'project-snapshot.toggleContents', title: 'Toggle Contents' };

        const settingsItem = new vscode.TreeItem('Edit Ignore Rules', vscode.TreeItemCollapsibleState.None);
        settingsItem.iconPath = new vscode.ThemeIcon('settings-gear');
        settingsItem.command = { command: 'project-snapshot.openSettings', title: 'Settings' };

        return Promise.resolve([generateItem, toggleTreeItem, toggleContentsItem, settingsItem]);
    }
}

// ─── Port Manager Provider ────────────────────────────────────────────────────

// Custom TreeItem to natively hold the PID without breaking left-clicks
class PortTreeItem extends vscode.TreeItem {
    constructor(
        public readonly port: number,
        public readonly pid: number,
        public readonly processName: string
    ) {
        super(`Port ${port}`, vscode.TreeItemCollapsibleState.None);
        this.description = `${processName} (PID: ${pid})`;
        this.iconPath = new vscode.ThemeIcon('radio-tower');
        this.contextValue = 'portItem';
        this.tooltip = `Running process: ${processName} on PID ${pid}`;
    }
}

async function getProcessDetailsFromPid(pid: number): Promise<string> {
    return new Promise((resolve) => {
        const isWin = os.platform() === 'win32';
        const cmd = isWin 
            ? `wmic process where processid=${pid} get commandline` 
            : `ps -p ${pid} -o command=`;

        exec(cmd, (err, stdout) => {
            if (err || !stdout.trim()) { return resolve('Unknown Process'); }

            let detail = stdout.trim();
            
            if (isWin) {
                const lines = detail.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                detail = lines.length > 1 ? lines[1] : lines[0];
            }

            if (!detail) { return resolve('Unknown Process'); }

            if (detail.toLowerCase().includes('node') || detail.includes('Code Helper') || detail.includes('python')) {
                const fileMatch = detail.match(/([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)(?:\s|$)/g);
                if (fileMatch && fileMatch.length > 0) {
                    const scriptName = fileMatch[fileMatch.length - 1].trim();
                    return resolve(`Running: ${scriptName}`);
                }
            }

            if (detail.length > 40) {
                detail = detail.substring(0, 37) + '...';
            }

            resolve(detail);
        });
    });
}

function getOpenPorts(): Promise<PortProcess[]> {
    return new Promise((resolve) => {
        const isWin = os.platform() === 'win32';
        const cmd = isWin ? 'netstat -ano | findstr LISTENING' : 'lsof -iTCP -sTCP:LISTEN -n -P';
        
        exec(cmd, (err, stdout) => {
            if (err) { return resolve([]); }
            
            const results: PortProcess[] = [];
            const lines = stdout.split('\n');
            
            for (const line of lines) {
                if (isWin) {
                    const match = line.match(/TCP\s+[^\s]+:(\d+)\s+[^\s]+\s+LISTENING\s+(\d+)/);
                    if (match) {
                        results.push({ port: parseInt(match[1]), pid: parseInt(match[2]), name: 'Process' });
                    }
                } else {
                    const match = line.match(/^([^\s]+)\s+(\d+).*?:(\d+)\s+\(LISTEN\)/);
                    if (match) {
                        results.push({ name: match[1], pid: parseInt(match[2]), port: parseInt(match[3]) });
                    }
                }
            }
            
            const unique = Array.from(new Map(results.map(p => [p.port, p])).values());
            
            // Enrich basic names with detailed command line scripts
            Promise.all(unique.map(async (p) => {
                const detailName = await getProcessDetailsFromPid(p.pid);
                return { 
                    ...p, 
                    name: detailName !== 'Unknown Process' ? detailName : p.name 
                };
            })).then(enrichedPorts => {
                resolve(enrichedPorts.sort((a, b) => a.port - b.port));
            });
        });
    });
}

class PortManagerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element) { return []; }

        const ports = await getOpenPorts();
        
        if (ports.length === 0) {
            const emptyItem = new vscode.TreeItem('No active ports found', vscode.TreeItemCollapsibleState.None);
            emptyItem.iconPath = new vscode.ThemeIcon('info');
            return [emptyItem];
        }

        return ports.map(p => new PortTreeItem(p.port, p.pid, p.name));
    }
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    // 1. Setup Providers
    const configProvider = new SnapshotConfigProvider();
    vscode.window.registerTreeDataProvider('project-snapshot.configView', configProvider);

    const portProvider = new PortManagerProvider();
    vscode.window.registerTreeDataProvider('project-snapshot.portView', portProvider);

    // Refresh UI automatically if settings change
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('projectSnapshot')) {
            configProvider.refresh();
        }
    });

    // 2. Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('project-snapshot.generate', async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
            const targets = selectedUris?.length ? selectedUris : uri ? [uri] : [];
            await generateSnapshot(targets);
        }),

        vscode.commands.registerCommand('project-snapshot.openInNewWindow', async (uri: vscode.Uri, selectedUris: vscode.Uri[]) => {
            if (selectedUris && selectedUris.length > 1) { return; }
            if (!uri) { return; }

            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            const isRoot = workspaceFolder && workspaceFolder.uri.fsPath === uri.fsPath;
            if (isRoot) { return; }

            await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        }),

        vscode.commands.registerCommand('project-snapshot.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'projectSnapshot.globalIgnores');
        }),

        vscode.commands.registerCommand('project-snapshot.toggleTree', async () => {
            const config = vscode.workspace.getConfiguration('projectSnapshot');
            const current = config.get<boolean>('includeDirectoryTree') ?? true;
            await config.update('includeDirectoryTree', !current, vscode.ConfigurationTarget.Global);
        }),

        vscode.commands.registerCommand('project-snapshot.toggleContents', async () => {
            const config = vscode.workspace.getConfiguration('projectSnapshot');
            const current = config.get<boolean>('includeFileContents') ?? true;
            await config.update('includeFileContents', !current, vscode.ConfigurationTarget.Global);
        }),

        vscode.commands.registerCommand('project-snapshot.refreshPorts', () => {
            portProvider.refresh();
        }),

        // Updated killPort command taking the PortTreeItem class
        vscode.commands.registerCommand('project-snapshot.killPort', async (treeItem: PortTreeItem) => {
            const pid = treeItem.pid;
            if (!pid) { return; }

            const confirm = await vscode.window.showWarningMessage(`Kill process ${pid}?`, { modal: true }, 'Yes', 'No');
            if (confirm !== 'Yes') { return; }

            const isWin = os.platform() === 'win32';
            const cmd = isWin ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`;

            exec(cmd, (err) => {
                if (err) {
                    vscode.window.showErrorMessage(`Failed to kill PID ${pid}: ${err.message}`);
                } else {
                    vscode.window.showInformationMessage(`Successfully killed PID ${pid}`);
                    portProvider.refresh();
                }
            });
        })
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
    
    // Normalize ignores: strip "/**" to leave trailing slashes for standard gitignore matching
    const normalizedIgnores = globalIgnores.map(p => {
        const trimmed = p.trim();
        return trimmed.endsWith('/**') ? trimmed.slice(0, -2) : trimmed;
    });
    const ig = ignore().add(normalizedIgnores);
    
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

                    const dirTargets:  vscode.Uri[] = [];
                    const fileTargets: vscode.Uri[] = [];

                    await Promise.all(targets.map(async (t) => {
                        const stat = await fs.promises.stat(t.fsPath);
                        (stat.isDirectory() ? dirTargets : fileTargets).push(t);
                    }));

                    const treeParts: string[] = [];
                    const allFiles:  FileEntry[] = [];

                    for (const t of fileTargets) {
                        const rel = path.relative(workspaceRoot, t.fsPath).replace(/\\/g, '/');
                        if (!ig.ignores(rel)) {
                            treeParts.push(`${rel}\n`);
                            allFiles.push({ relativePath: rel, fullPath: t.fsPath });
                        }
                    }

                    for (const t of dirTargets) {
                        const r = await scanDirectory(t.fsPath, workspaceRoot, ig, includeAllExts, allowedExts);
                        treeParts.push(r.tree);
                        allFiles.push(...r.files);
                    }

                    const uniqueFiles = Array.from(
                        new Map(allFiles.map(f => [f.fullPath, f])).values()
                    );

                    progress.report({ increment: 30, message: 'Reading files...' });
                    const fileContents = await generateFileContents(uniqueFiles, progress);

                    progress.report({ increment: 10, message: 'Writing...' });
                    
                    const includeTree = config.get<boolean>('includeDirectoryTree') ?? true;
                    const includeContents = config.get<boolean>('includeFileContents') ?? true;

                    let snapshot = '';

                    if (includeTree) {
                        snapshot += '==================== PROJECT DIRECTORY STRUCTURE ====================\n\n' + treeParts.join('');
                    }

                    if (includeContents) {
                        snapshot += (snapshot.length > 0 ? '\n\n' : '') + '==================== FILE CONTENTS ====================\n\n' + fileContents;
                    }

                    if (!includeTree && !includeContents) {
                        snapshot = "Snapshot generated with both Tree and Contents disabled.";
                    }

                    const rootFolderName = path.basename(workspaceRoot);
                    const tempFilePath   = path.join(os.tmpdir(), `${rootFolderName}-schema.md`);
                    await fs.promises.writeFile(tempFilePath, snapshot, 'utf-8');

                    let copyMethod = 'File';
                    try {
                        await copyNativeFileToClipboard(tempFilePath);
                    } catch {
                        if (snapshot.length < 5000000) { 
                            await vscode.env.clipboard.writeText(snapshot);
                            copyMethod = 'Content';
                        } else {
                            await vscode.env.clipboard.writeText(tempFilePath);
                            copyMethod = 'Path (File too large for text clipboard)';
                        }
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
    ig:            any,
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
            const checkPath = e.isDirectory() ? rel + '/' : rel;
            return !ig.ignores(checkPath);
        });

        const dirs  = valid.filter((e: fs.Dirent) => e.isDirectory() ).sort((a, b) => a.name.localeCompare(b.name));
        const fents = valid.filter((e: fs.Dirent) => e.isFile()      ).sort((a, b) => a.name.localeCompare(b.name));

        for (const e of dirs) {
            treeParts.push(`${indent}${e.name}/\n`);
            await walk(path.join(dir, e.name), level + 1);
        }

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
    
    const config = vscode.workspace.getConfiguration('projectSnapshot');
    const maxSizeBytes = (config.get<number>('maxFileSizeKB') || 1000) * 1024;

    for (let i = 0; i < total; i += READ_CONCURRENCY) {
        const batch = files.slice(i, i + READ_CONCURRENCY);
        await Promise.all(batch.map(async (file, j) => {
            const idx = i + j;
            try {
                const stat = await fs.promises.stat(file.fullPath);
                
                if (stat.size > maxSizeBytes) {
                    results[idx] = `<file path="${file.relativePath}">\n[File skipped: Exceeds size limit of ${Math.round(stat.size / 1024)}KB]\n</file>\n\n`;
                    return;
                }

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
            const escaped = filePath.replace(/'/g, "''");
            command = `powershell.exe -STA -NoProfile -NonInteractive -Command "Get-Item -LiteralPath '${escaped}' | Set-Clipboard"`;
        } else if (platform === 'darwin') {
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