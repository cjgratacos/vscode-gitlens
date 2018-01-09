'use strict';
import { Arrays, Iterables } from '../system';
import { CancellationToken, Disposable, ExtensionContext, Hover, HoverProvider, languages, Position, Range, TextDocument, TextEditor, TextEditorDecorationType } from 'vscode';
import { FileAnnotationType } from './annotationController';
import { AnnotationProviderBase } from './annotationProvider';
import { Annotations } from './annotations';
import { RangeEndOfLineIndex } from '../constants';
import { TrackedDocument } from '../documentStateTracker';
import { GitBlame, GitCommit, GitDocumentState, GitService, GitUri } from '../gitService';

export abstract class BlameAnnotationProviderBase extends AnnotationProviderBase {

    protected _blame: Promise<GitBlame | undefined>;
    protected _hoverProviderDisposable: Disposable;
    protected readonly _uri: GitUri;

    constructor(
        context: ExtensionContext,
        editor: TextEditor,
        trackedDocument: TrackedDocument<GitDocumentState>,
        decoration: TextEditorDecorationType | undefined,
        highlightDecoration: TextEditorDecorationType | undefined,
        protected readonly _git: GitService
    ) {
        super(context, editor, trackedDocument, decoration, highlightDecoration);

        this._uri = trackedDocument.uri;
        this._blame = editor.document.isDirty
            ? this._git.getBlameForFileContents(this._uri, editor.document.getText())
            : this._git.getBlameForFile(this._uri);

        if (editor.document.isDirty) {
            trackedDocument.setTriggerOnNextChange();
        }
    }

    async clear() {
        this._hoverProviderDisposable && this._hoverProviderDisposable.dispose();
        super.clear();
    }

    async onReset(changes?: { decoration: TextEditorDecorationType | undefined, highlightDecoration: TextEditorDecorationType | undefined }) {
        if (this.editor !== undefined) {
            this._blame = this.editor.document.isDirty
                ? this._git.getBlameForFileContents(this._uri, this.editor.document.getText())
                : this._git.getBlameForFile(this._uri);
        }

        super.onReset(changes);
    }

    async selection(shaOrLine?: string | number, blame?: GitBlame) {
        if (!this._highlightDecoration) return;

        if (blame === undefined) {
            blame = await this._blame;
            if (!blame || !blame.lines.length) return;
        }

        let sha: string | undefined = undefined;
        if (typeof shaOrLine === 'string') {
            sha = shaOrLine;
        }
        else if (typeof shaOrLine === 'number') {
            if (shaOrLine >= 0) {
                const commitLine = blame.lines[shaOrLine];
                sha = commitLine && commitLine.sha;
            }
        }
        else {
            sha = Iterables.first(blame.commits.values()).sha;
        }

        if (!sha) {
            this.editor.setDecorations(this._highlightDecoration, []);
            return;
        }

        const highlightDecorationRanges = Arrays.filterMap(blame.lines,
            l => l.sha === sha ? this.editor.document.validateRange(new Range(l.line, 0, l.line, RangeEndOfLineIndex)) : undefined);

        this.editor.setDecorations(this._highlightDecoration, highlightDecorationRanges);
    }

    async validate(): Promise<boolean> {
        const blame = await this._blame;
        return blame !== undefined && blame.lines.length !== 0;
    }

    protected async getBlame(): Promise<GitBlame | undefined> {
        const blame = await this._blame;
        if (blame === undefined || blame.lines.length === 0) return undefined;

        return blame;
    }

    registerHoverProviders(providers: { details: boolean, changes: boolean }) {
        if (!providers.details && !providers.changes) return;

        const subscriptions: Disposable[] = [];
        if (providers.changes) {
            subscriptions.push(languages.registerHoverProvider({ pattern: this.document.uri.fsPath }, { provideHover: this.provideChangesHover.bind(this) } as HoverProvider));
        }
        if (providers.details) {
            subscriptions.push(languages.registerHoverProvider({ pattern: this.document.uri.fsPath }, { provideHover: this.provideDetailsHover.bind(this) } as HoverProvider));
        }

        this._hoverProviderDisposable = Disposable.from(...subscriptions);
    }

    async provideDetailsHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        const commit = await this.getCommitForHover(position);
        if (commit === undefined) return undefined;

        // Get the full commit message -- since blame only returns the summary
        let logCommit: GitCommit | undefined = undefined;
        if (!commit.isUncommitted) {
            logCommit = await this._git.getLogCommit(commit.repoPath, commit.uri.fsPath, commit.sha);
            if (logCommit !== undefined) {
                // Preserve the previous commit from the blame commit
                logCommit.previousFileName = commit.previousFileName;
                logCommit.previousSha = commit.previousSha;
            }
        }

        const message = Annotations.getHoverMessage(logCommit || commit, this._config.defaultDateFormat, await this._git.hasRemote(commit.repoPath), this._config.blame.file.annotationType);
        return new Hover(message, document.validateRange(new Range(position.line, 0, position.line, RangeEndOfLineIndex)));
    }

    async provideChangesHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
        const commit = await this.getCommitForHover(position);
        if (commit === undefined) return undefined;

        const hover = await Annotations.changesHover(commit, position.line, await GitUri.fromUri(document.uri, this._git), this._git);
        return new Hover(hover.hoverMessage!, document.validateRange(new Range(position.line, 0, position.line, RangeEndOfLineIndex)));
    }

    private async getCommitForHover(position: Position): Promise<GitCommit | undefined> {
        const annotationType = this._config.blame.file.annotationType;
        const wholeLine = annotationType === FileAnnotationType.Hover || (annotationType === FileAnnotationType.Gutter && this._config.annotations.file.gutter.hover.wholeLine);
        if (!wholeLine && position.character !== 0) return undefined;

        const blame = await this.getBlame();
        if (blame === undefined) return undefined;

        const line = blame.lines[position.line];

        return blame.commits.get(line.sha);
    }
}