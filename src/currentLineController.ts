'use strict';
import { Functions, IDeferrable } from './system';
import { CancellationToken, ConfigurationChangeEvent, debug, DecorationRangeBehavior, DecorationRenderOptions, Disposable, ExtensionContext, Hover, HoverProvider, languages, Position, Range, StatusBarAlignment, StatusBarItem, TextDocument, TextEditor, TextEditorDecorationType, TextEditorSelectionChangeEvent, window } from 'vscode';
import { AnnotationController, FileAnnotationType } from './annotations/annotationController';
import { Annotations } from './annotations/annotations';
import { Commands } from './commands';
import { TextEditorComparer } from './comparers';
import { configuration, IConfig, StatusBarCommand } from './configuration';
import { DocumentSchemes, isTextEditor, RangeEndOfLineIndex } from './constants';
import { DocumentBlameStateChangeEvent, DocumentDirtyStateChangeEvent, DocumentStateTracker } from './documentStateTracker';
import { CommitFormatter, GitCommit, GitCommitLine, GitDocumentState, GitLogCommit, GitService, GitUri, ICommitFormatOptions } from './gitService';
import { Logger } from './logger';

const annotationDecoration: TextEditorDecorationType = window.createTextEditorDecorationType({
    after: {
        margin: '0 0 0 3em',
        textDecoration: 'none'
    },
    rangeBehavior: DecorationRangeBehavior.ClosedClosed
} as DecorationRenderOptions);

export enum LineAnnotationType {
    Trailing = 'trailing',
    Hover = 'hover'
}

export class CurrentLineController extends Disposable {

    private _blameable: boolean;
    private _blameLineAnnotationState: { enabled: boolean, annotationType: LineAnnotationType, reason: 'user' | 'debugging' } | undefined;
    private _config: IConfig;
    private _currentLine: { line: number, commit?: GitCommit, logCommit?: GitLogCommit, dirty?: boolean } = { line: -1 };
    private _debugSessionEndDisposable: Disposable | undefined;
    private _disposable: Disposable;
    private _editor: TextEditor | undefined;
    private _hoverProviderDisposable: Disposable | undefined;
    private _isAnnotating: boolean = false;
    private _statusBarItem: StatusBarItem | undefined;
    private _trackCurrentLineDisposable: Disposable | undefined;
    private _updateBlameDebounced: ((line: number, editor: TextEditor) => Promise<void>) & IDeferrable;
    private _uri: GitUri;

    constructor(
        context: ExtensionContext,
        private readonly _git: GitService,
        private readonly _tracker: DocumentStateTracker<GitDocumentState>,
        private readonly _annotationController: AnnotationController
    ) {
        super(() => this.dispose());

        this._updateBlameDebounced = Functions.debounce(this.updateBlame, 250, { track: true });

        this._disposable = Disposable.from(
            configuration.onDidChange(this.onConfigurationChanged, this),
            _annotationController.onDidToggleAnnotations(this.onFileAnnotationsToggled, this),
            debug.onDidStartDebugSession(this.onDebugSessionStarted, this)
        );
        this.onConfigurationChanged(configuration.initializingChangeEvent);
    }

    dispose() {
        this.clearAnnotations(this._editor, true);

        this.unregisterHoverProviders();
        this._trackCurrentLineDisposable && this._trackCurrentLineDisposable.dispose();
        this._statusBarItem && this._statusBarItem.dispose();
        this._debugSessionEndDisposable && this._debugSessionEndDisposable.dispose();
        this._disposable && this._disposable.dispose();
    }

    private onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        const cfg = configuration.get<IConfig>();

        let changed = false;

        if (initializing || configuration.changed(e, configuration.name('blame')('line').value)) {
            changed = true;
            this._blameLineAnnotationState = undefined;
        }

        if (initializing ||
            configuration.changed(e, configuration.name('annotations')('line')('trailing').value) ||
            configuration.changed(e, configuration.name('annotations')('line')('hover').value)) {
            changed = true;
        }

        if (initializing || configuration.changed(e, configuration.name('statusBar').value)) {
            changed = true;

            if (cfg.statusBar.enabled) {
                const alignment = cfg.statusBar.alignment !== 'left' ? StatusBarAlignment.Right : StatusBarAlignment.Left;
                if (this._statusBarItem !== undefined && this._statusBarItem.alignment !== alignment) {
                    this._statusBarItem.dispose();
                    this._statusBarItem = undefined;
                }

                this._statusBarItem = this._statusBarItem || window.createStatusBarItem(alignment, alignment === StatusBarAlignment.Right ? 1000 : 0);
                this._statusBarItem.command = cfg.statusBar.command;
            }
            else if (this._statusBarItem !== undefined) {
                this._statusBarItem.dispose();
                this._statusBarItem = undefined;
            }
        }

        this._config = cfg;

        if (!changed) return;

        const trackCurrentLine = cfg.statusBar.enabled ||
            cfg.blame.line.enabled ||
            (this._blameLineAnnotationState !== undefined && this._blameLineAnnotationState.enabled);

        if (trackCurrentLine) {
            this._trackCurrentLineDisposable = this._trackCurrentLineDisposable || Disposable.from(
                window.onDidChangeActiveTextEditor(Functions.debounce(this.onActiveTextEditorChanged, 50), this),
                window.onDidChangeTextEditorSelection(this.onTextEditorSelectionChanged, this),
                this._tracker.onDidChangeBlameState(this.onBlameStateChanged, this),
                this._tracker.onDidChangeDirtyState(this.onDirtyStateChanged, this)
            );
        }
        else if (this._trackCurrentLineDisposable !== undefined) {
            this._trackCurrentLineDisposable.dispose();
            this._trackCurrentLineDisposable = undefined;
        }

        this.refresh(window.activeTextEditor);
    }

    private onActiveTextEditorChanged(editor: TextEditor | undefined) {
        if (this._editor === editor) return;
        if (editor !== undefined && !isTextEditor(editor)) return;

        // Logger.log('CurrentLineController.onActiveTextEditorChanged', editor && editor.document.uri.fsPath);

        this.refresh(editor);
    }

    private onBlameStateChanged(e: DocumentBlameStateChangeEvent) {
        // // Make sure this is for the editor we are tracking
        // if (!TextEditorComparer.equals(this._editor, e.editor)) return;

        // If we still aren't blameable -- kick out
        if (!this._blameable && !e.blameable) {
            this._updateBlameDebounced.cancel();

            return;
        }

        this._blameable = e.blameable;
        if (!this.canBlame || this._editor === undefined) {
            this._updateBlameDebounced.cancel();
            this.clear(this._editor);

            return;
        }

        this._updateBlameDebounced(this._editor.selection.active.line, this._editor);
    }

    private onDebugSessionStarted() {
        const state = this.getLineAnnotationState();
        if (!state.enabled) return;

        this._debugSessionEndDisposable = debug.onDidTerminateDebugSession(this.onDebugSessionEnded, this);
        this.toggleAnnotations(window.activeTextEditor, state.annotationType, 'debugging');
    }

    private onDebugSessionEnded() {
        this._debugSessionEndDisposable && this._debugSessionEndDisposable.dispose();
        this._debugSessionEndDisposable = undefined;

        if (this._blameLineAnnotationState === undefined || this._blameLineAnnotationState.enabled || this._blameLineAnnotationState.reason !== 'debugging') return;

        this.toggleAnnotations(window.activeTextEditor, this._blameLineAnnotationState.annotationType);
    }

    private onFileAnnotationsToggled() {
        this.refresh(window.activeTextEditor);
    }

    private _fooDebounced: (() => void) & IDeferrable;
    private _considerDirty: boolean = false;

    private async onDirtyStateChanged(e: DocumentDirtyStateChangeEvent) {
        Logger.log('CurrentLineController.onDirtyStateChanged', e.dirty);

        this._considerDirty = e.dirty;
        if (e.dirty) {
            this.clear(this._editor);

            if (this._fooDebounced === undefined) {
                this._fooDebounced = Functions.debounce(() => {
                    Logger.log('CurrentLineController.onDirtyStateChanged - clear');
                    this._considerDirty = false;
                }, 5000);
            }

            this._fooDebounced();
        }
        else {
            if (this._fooDebounced !== undefined) {
                this._fooDebounced.cancel();
            }

            this.refresh(this._editor);
        }
    }

    private get canBlame() {
        return this._blameable && !this._considerDirty;
    }

    private async onTextEditorSelectionChanged(e: TextEditorSelectionChangeEvent): Promise<void> {
        // Make sure this is for the editor we are tracking
        if (!this._blameable || !TextEditorComparer.equals(this._editor, e.textEditor)) return;

        const line = e.selections[0].active.line;
        if (line === this._currentLine.line) return;

        this._currentLine.line = line;
        this._currentLine.commit = undefined;
        this._currentLine.logCommit = undefined;

        if (this._uri === undefined && e.textEditor !== undefined) {
            this._uri = await GitUri.fromUri(e.textEditor.document.uri, this._git);
        }

        if (this.canBlame) {
            this.clearAnnotations(e.textEditor);
            this._updateBlameDebounced(line, e.textEditor);
        }
    }

    private getLineAnnotationState() {
        return this._blameLineAnnotationState !== undefined ? this._blameLineAnnotationState : this._config.blame.line;
    }

    private isEditorBlameable(editor: TextEditor | undefined): boolean {
        if (editor === undefined || editor.document === undefined) return false;

        if (!this._git.isTrackable(editor.document.uri)) return false;
        if (editor.document.isUntitled && editor.document.uri.scheme === DocumentSchemes.File) return false;

        return this._git.isEditorBlameable(editor);
    }

    private async updateBlame(line: number, editor: TextEditor) {
        if (this._updateBlameDebounced.pending!()) return;

        this.clearLineState(line);

        let commit;
        let commitLine;
        // Since blame information isn't valid when there are unsaved changes -- don't show any status
        if (this.canBlame && line >= 0) {
            const blameLine = editor.document.isDirty
                ? await this._git.getBlameForLineContents(this._uri, line, editor.document.getText())
                : await this._git.getBlameForLine(this._uri, line);

            const pending = this._updateBlameDebounced.pending!();

            // Make sure we are still blameable after the await (and there aren't more updates pending)
            if (this.canBlame && !pending) {
                commitLine = blameLine === undefined ? undefined : blameLine.line;
                commit = blameLine === undefined ? undefined : blameLine.commit;
            }
        }

        this._currentLine.commit = commit;

        if (commit !== undefined && commitLine !== undefined) {
            this.show(commit, commitLine, editor, line);
        }
        else {
            this.clear(editor);
        }
    }

    private clearLineState(line?: number) {
        if (line !== undefined) {
            this._currentLine.line = line;
        }

        this._currentLine.commit = undefined;
        this._currentLine.logCommit = undefined;
    }

    async clear(editor: TextEditor | undefined) {
        this._updateBlameDebounced.cancel();

        this.clearLineState();

        this.unregisterHoverProviders();
        this.clearAnnotations(editor, true);
        this._statusBarItem && this._statusBarItem.hide();
    }

    private clearAnnotations(editor: TextEditor | undefined, force: boolean = false) {
        if (editor === undefined || (!this._isAnnotating && !force)) return;

        editor.setDecorations(annotationDecoration, []);
        this._isAnnotating = false;
    }

    async refresh(editor?: TextEditor) {
        this._currentLine.line = -1;

        if (editor === undefined && this._editor === undefined) return;

        this.clearAnnotations(this._editor);

        this._blameable = this.isEditorBlameable(editor);
        if (!this.canBlame || editor === undefined) {
            this.clear(editor!);
            this._editor = undefined;

            return;
        }

        this._editor = editor;
        this._uri = await GitUri.fromUri(editor.document.uri, this._git);

        const maxLines = this._config.advanced.caching.maxLines;
        // If caching is on and the file is small enough -- kick off a blame for the whole file
        if (this._config.advanced.caching.enabled && (maxLines <= 0 || editor.document.lineCount <= maxLines)) {
            this._git.getBlameForFile(this._uri);
        }

        const state = this.getLineAnnotationState();
        if (state.enabled && this.canBlame) {
            const cfg = this._config.annotations.line;
            this.registerHoverProviders(state.annotationType === LineAnnotationType.Trailing ? cfg.trailing.hover : cfg.hover);
        }
        else {
            this.unregisterHoverProviders();
        }

        this._updateBlameDebounced(editor.selection.active.line, editor);
    }

    async show(commit: GitCommit, blameLine: GitCommitLine, editor: TextEditor, line: number) {
        // I have no idea why I need this protection -- but it happens
        if (editor.document === undefined) return;

        if (editor.document.isDirty) {
            const doc = this._tracker.get(editor.document);
            if (doc !== undefined) {
                doc.setTriggerOnNextChange();
            }
        }

        this.updateStatusBar(commit);
        this.updateTrailingAnnotation(commit, blameLine, editor, line);
    }

    async showAnnotations(editor: TextEditor | undefined, type: LineAnnotationType, reason: 'user' | 'debugging' = 'user') {
        if (editor === undefined) return;

        const state = this.getLineAnnotationState();
        if (!state.enabled || state.annotationType !== type) {
            this._blameLineAnnotationState = { enabled: true, annotationType: type, reason: reason };

            this.clearAnnotations(editor);
            await this.updateBlame(editor.selection.active.line, editor);
        }
    }

    async toggleAnnotations(editor: TextEditor | undefined, type: LineAnnotationType, reason: 'user' | 'debugging' = 'user') {
        if (editor === undefined) return;

        const state = this.getLineAnnotationState();
        this._blameLineAnnotationState = { enabled: !state.enabled, annotationType: type, reason: reason };

        this.clearAnnotations(editor);
        await this.updateBlame(editor.selection.active.line, editor);
    }

    private updateStatusBar(commit: GitCommit) {
        const cfg = this._config.statusBar;
        if (!cfg.enabled || this._statusBarItem === undefined) return;

        this._statusBarItem.text = `$(git-commit) ${CommitFormatter.fromTemplate(cfg.format, commit, {
            truncateMessageAtNewLine: true,
            dateFormat: cfg.dateFormat === null ? this._config.defaultDateFormat : cfg.dateFormat
        } as ICommitFormatOptions)}`;

        switch (cfg.command) {
            case StatusBarCommand.ToggleFileBlame:
                this._statusBarItem.tooltip = 'Toggle Blame Annotations';
                break;
            case StatusBarCommand.DiffWithPrevious:
                this._statusBarItem.command = Commands.DiffLineWithPrevious;
                this._statusBarItem.tooltip = 'Compare Line Revision with Previous';
                break;
            case StatusBarCommand.DiffWithWorking:
                this._statusBarItem.command = Commands.DiffLineWithWorking;
                this._statusBarItem.tooltip = 'Compare Line Revision with Working';
                break;
            case StatusBarCommand.ToggleCodeLens:
                this._statusBarItem.tooltip = 'Toggle Git CodeLens';
                break;
            case StatusBarCommand.ShowQuickCommitDetails:
                this._statusBarItem.tooltip = 'Show Commit Details';
                break;
            case StatusBarCommand.ShowQuickCommitFileDetails:
                this._statusBarItem.tooltip = 'Show Line Commit Details';
                break;
            case StatusBarCommand.ShowQuickFileHistory:
                this._statusBarItem.tooltip = 'Show File History';
                break;
            case StatusBarCommand.ShowQuickCurrentBranchHistory:
                this._statusBarItem.tooltip = 'Show Branch History';
                break;
        }

        this._statusBarItem.show();
    }

    private async updateTrailingAnnotation(commit: GitCommit, blameLine: GitCommitLine, editor: TextEditor, line?: number) {
        const state = this.getLineAnnotationState();
        if (!state.enabled || state.annotationType !== LineAnnotationType.Trailing || !isTextEditor(editor)) return;

        line = line === undefined ? blameLine.line : line;

        const cfg = this._config.annotations.line.trailing;
        const decoration = Annotations.trailing(commit, cfg.format, cfg.dateFormat === null ? this._config.defaultDateFormat : cfg.dateFormat);
        decoration.range = editor.document.validateRange(new Range(line, RangeEndOfLineIndex, line, RangeEndOfLineIndex));

        editor.setDecorations(annotationDecoration, [decoration]);
        this._isAnnotating = true;
    }

    registerHoverProviders(providers: { details: boolean, changes: boolean }) {
        this.unregisterHoverProviders();

        if (this._editor === undefined) return;
        if (!providers.details && !providers.changes) return;

        const subscriptions: Disposable[] = [];
        if (providers.changes) {
            subscriptions.push(languages.registerHoverProvider({ pattern: this._editor.document.uri.fsPath }, { provideHover: this.provideChangesHover.bind(this) } as HoverProvider));
        }
        if (providers.details) {
            subscriptions.push(languages.registerHoverProvider({ pattern: this._editor.document.uri.fsPath }, { provideHover: this.provideDetailsHover.bind(this) } as HoverProvider));
        }

        this._hoverProviderDisposable = Disposable.from(...subscriptions);
    }

    unregisterHoverProviders() {
        if (this._hoverProviderDisposable !== undefined) {
            this._hoverProviderDisposable.dispose();
            this._hoverProviderDisposable = undefined;
        }
    }

    async provideDetailsHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        if (this._editor === undefined || this._editor.document !== document) return undefined;
        if (this._currentLine.line !== position.line) return undefined;

        const commit = this._currentLine.commit;
        if (commit === undefined) return undefined;

        const fileAnnotations = this._annotationController.getAnnotationType(this._editor);
        // Avoid double annotations if we are showing the whole-file hover blame annotations
        if ((fileAnnotations === FileAnnotationType.Gutter && this._config.annotations.file.gutter.hover.details) ||
            (fileAnnotations === FileAnnotationType.Hover && this._config.annotations.file.hover.details)) {
            return undefined;
        }

        const state = this.getLineAnnotationState();
        const wholeLine = state.annotationType === LineAnnotationType.Hover || (state.annotationType === LineAnnotationType.Trailing && this._config.annotations.line.trailing.hover.wholeLine) ||
            fileAnnotations === FileAnnotationType.Hover || (fileAnnotations === FileAnnotationType.Gutter && this._config.annotations.file.gutter.hover.wholeLine);

        const range = document.validateRange(new Range(position.line, wholeLine ? 0 : RangeEndOfLineIndex, position.line, RangeEndOfLineIndex));
        if (!wholeLine && range.start.character !== position.character) return undefined;

        // Get the full commit message -- since blame only returns the summary
        let logCommit = this._currentLine.logCommit;
        if (logCommit === undefined && !commit.isUncommitted) {
            logCommit = await this._git.getLogCommit(commit.repoPath, commit.uri.fsPath, commit.sha);
            if (logCommit !== undefined) {
                // Preserve the previous commit from the blame commit
                logCommit.previousSha = commit.previousSha;
                logCommit.previousFileName = commit.previousFileName;

                this._currentLine.logCommit = logCommit;
            }
        }

        const message = Annotations.getHoverMessage(logCommit || commit, this._config.defaultDateFormat, await this._git.hasRemote(commit.repoPath), this._config.blame.file.annotationType);
        return new Hover(message, range);
    }

    async provideChangesHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        if (this._editor === undefined || this._editor.document !== document) return undefined;
        if (this._currentLine.line !== position.line) return undefined;

        const commit = this._currentLine.commit;
        if (commit === undefined) return undefined;

        const fileAnnotations = this._annotationController.getAnnotationType(this._editor);
        // Avoid double annotations if we are showing the whole-file hover blame annotations
        if ((fileAnnotations === FileAnnotationType.Gutter && this._config.annotations.file.gutter.hover.changes) ||
            (fileAnnotations === FileAnnotationType.Hover && this._config.annotations.file.hover.changes)) {
            return undefined;
        }

        const state = this.getLineAnnotationState();
        const wholeLine = state.annotationType === LineAnnotationType.Hover || (state.annotationType === LineAnnotationType.Trailing && this._config.annotations.line.trailing.hover.wholeLine) ||
            fileAnnotations === FileAnnotationType.Hover || (fileAnnotations === FileAnnotationType.Gutter && this._config.annotations.file.gutter.hover.wholeLine);

        const range = document.validateRange(new Range(position.line, wholeLine ? 0 : RangeEndOfLineIndex, position.line, RangeEndOfLineIndex));
        if (!wholeLine && range.start.character !== position.character) return undefined;

        const hover = await Annotations.changesHover(commit, position.line, this._uri, this._git);
        if (hover.hoverMessage === undefined) return undefined;

        return new Hover(hover.hoverMessage, range);
    }
}