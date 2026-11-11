import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/languages/definitions/cpp/register';
// Editor features are separate modules in this Monaco version; load the ones a code editor needs.
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/caretOperations/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/lineSelection/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/smartSelect/register';
import 'monaco-editor/features/snippet/register';
import 'monaco-editor/features/suggest/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
// These controllers are not covered by a feature module but are part of Monaco's full build.
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/common/standaloneStrings';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { useEffect, useRef, useState } from 'react';
import { PERIPHERALS, SYMBOLS, concreteMacros, lookup, peripheralFor } from '../reference/registers';
import { sourceById } from '../reference/sources';
import { actions, currentExercise, projectFiles, useApp } from './store';
import { Icon } from './App';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

function defineThemes(): void {
  const base = {
    inherit: true,
    rules: [],
  };
  monaco.editor.defineTheme('mcu-light', {
    ...base,
    base: 'vs',
    colors: {
      'editor.background': '#ffffff',
      'editorLineNumber.foreground': '#b5b1a6',
      'editorLineNumber.activeForeground': '#6d6a62',
      'editor.lineHighlightBackground': '#f6f5f1',
      'editorGutter.background': '#ffffff',
    },
  });
  monaco.editor.defineTheme('mcu-dark', {
    ...base,
    base: 'vs-dark',
    colors: {
      'editor.background': '#1f1f1b',
      'editorLineNumber.foreground': '#5c5a53',
      'editorLineNumber.activeForeground': '#a3a097',
      'editor.lineHighlightBackground': '#26261f',
      'editorGutter.background': '#1f1f1b',
    },
  });
}
defineThemes();

// ------------------------------------------------- reference integration

/** The register expression or identifier under a position: "RCC->AHBENR" or "RCC_AHBENR_GPIOAEN". */
function expressionAt(model: monaco.editor.ITextModel, position: monaco.Position): { text: string; range: monaco.Range } | null {
  const line = model.getLineContent(position.lineNumber);
  for (const m of line.matchAll(/([A-Za-z_]\w*)->(\w+(?:\[\d\])?)/g)) {
    const start = m.index + 1;
    const end = start + m[0].length;
    if (position.column >= start && position.column <= end) {
      return { text: m[0], range: new monaco.Range(position.lineNumber, start, position.lineNumber, end) };
    }
  }
  const word = model.getWordAtPosition(position);
  return word ? { text: word.word, range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn) } : null;
}

/** Member names to offer after "PERIPH->", expanding array and numbered registers. */
function memberNames(member: string): string[] {
  if (member === 'AFR[0]') return ['AFR[0]', 'AFR[1]'];
  if (member === 'EXTICR[0]') return ['EXTICR[0]', 'EXTICR[1]', 'EXTICR[2]', 'EXTICR[3]'];
  if (member === 'CCR1') return ['CCR1', 'CCR2', 'CCR3', 'CCR4'];
  return [member];
}

function registerReferenceProviders(): monaco.IDisposable[] {
  const hover = monaco.languages.registerHoverProvider('c', {
    provideHover(model, position) {
      const expr = expressionAt(model, position);
      if (!expr) return null;
      const hit = lookup(expr.text);
      if (hit) {
        const src = sourceById(hit.periph.source.doc);
        const offset = `0x${hit.reg.offset.toString(16).toUpperCase().padStart(2, '0')}`;
        const lines = [`**${hit.periph.instances[0]}->${hit.reg.member}** \u00b7 ${hit.reg.title} \u00b7 offset ${offset}`, hit.reg.what];
        if (hit.field) lines.push(`**Bit${hit.field.bits.includes(':') ? 's' : ''} ${hit.field.bits} \u00b7 ${hit.field.name}** \u2014 ${hit.field.desc}`);
        else lines.push(`*Why:* ${hit.reg.why}`);
        lines.push(`*Source: ${src.short}, chapter \u201c${hit.periph.source.chapter}\u201d. Press F1 for the full register.*`);
        return { range: expr.range, contents: lines.map((value) => ({ value })) };
      }
      const sym = SYMBOLS.find((s) => s.name === expr.text);
      if (sym) {
        const src = sourceById(sym.source.doc);
        return {
          range: expr.range,
          contents: [{ value: '```c\n' + sym.signature + '\n```' }, { value: sym.desc }, { value: `*Source: ${src.short}, ${sym.source.chapter}.*` }],
        };
      }
      return null;
    },
  });

  const completion = monaco.languages.registerCompletionItemProvider('c', {
    triggerCharacters: ['>'],
    provideCompletionItems(model, position) {
      const before = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const arrow = /([A-Za-z_]\w*)->(\w*)$/.exec(before);
      if (arrow) {
        const periph = peripheralFor(arrow[1]);
        if (!periph) return { suggestions: [] };
        return {
          suggestions: periph.registers.flatMap((r, i) =>
            memberNames(r.member).map((name, j) => ({
              label: name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: name,
              detail: r.title,
              documentation: `${r.what}\n\n${r.why}`,
              sortText: String(i * 10 + j).padStart(4, '0'),
              range,
            })),
          ),
        };
      }
      const prefix = word.word;
      if (prefix.length < 3) return { suggestions: [] };
      const suggestions: monaco.languages.CompletionItem[] = [];
      for (const m of concreteMacros()) {
        if (m.macro.startsWith(prefix)) {
          suggestions.push({
            label: m.macro,
            kind: monaco.languages.CompletionItemKind.Constant,
            insertText: m.macro,
            detail: `${m.periph.id}->${m.reg.name} bit ${m.field.bits}`,
            documentation: m.field.desc,
            range,
          });
        }
      }
      for (const p of PERIPHERALS) {
        for (const inst of p.instances) {
          if (inst.startsWith(prefix)) {
            suggestions.push({ label: inst, kind: monaco.languages.CompletionItemKind.Variable, insertText: inst, detail: p.title, documentation: p.intro, range });
          }
        }
      }
      for (const s of SYMBOLS) {
        if (s.name.startsWith(prefix)) {
          suggestions.push({ label: s.name, kind: monaco.languages.CompletionItemKind.Function, insertText: s.name, detail: s.signature, documentation: s.desc, range });
        }
      }
      return { suggestions: suggestions.slice(0, 60) };
    },
  });
  return [hover, completion];
}

// Register once, also across hot reloads during development.
const providerHost = window as unknown as { __mcuReferenceProviders?: monaco.IDisposable[] };
providerHost.__mcuReferenceProviders?.forEach((d) => d.dispose());
providerHost.__mcuReferenceProviders = registerReferenceProviders();

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const themeName = () => (dark.matches ? 'mcu-dark' : 'mcu-light');

function languageFor(name: string): string {
  if (/\.(c|h)$/.test(name)) return 'c';
  return 'plaintext';
}

function modelFor(scope: string, name: string, content: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.parse(`file:///${scope}/${name}`);
  let model = monaco.editor.getModel(uri);
  if (!model) model = monaco.editor.createModel(content, languageFor(name), uri);
  return model;
}

export function CodeEditor() {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const suppress = useRef(false);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const projectId = useApp((s) => s.projectId);
  const activeFile = useApp((s) => s.activeFile);
  const viewing = useApp((s) => s.viewing);
  const content = useApp((s) => projectFiles(s)[s.activeFile] ?? '');
  const diagnostics = useApp((s) => s.build.diagnostics);
  const reveal = useApp((s) => s.reveal);
  const fault = useApp((s) => s.fault);
  const locations = useApp((s) => s.locations);

  useEffect(() => {
    const editor = monaco.editor.create(host.current!, {
      theme: themeName(),
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      tabSize: 4,
      insertSpaces: true,
      padding: { top: 10, bottom: 10 },
      overviewRulerBorder: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    (window as unknown as { __mcuEditor?: unknown }).__mcuEditor = editor; // handy for debugging from the console
    decorations.current = editor.createDecorationsCollection();
    editor.addAction({
      id: 'mcu.lookupReference',
      label: 'Look up in reference',
      keybindings: [monaco.KeyCode.F1],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: (ed) => {
        const pos = ed.getPosition();
        const model = ed.getModel();
        const expr = pos && model ? expressionAt(model, pos) : null;
        const hit = expr ? lookup(expr.text) : null;
        if (hit) actions.openReference(hit.periph.id, hit.reg.name);
        else if (expr && SYMBOLS.some((s) => s.name === expr.text)) actions.openReference('docs', null);
        else actions.openReference('guide', null);
      },
    });
    const sub = editor.onDidChangeModelContent(() => {
      if (suppress.current) return;
      const model = editor.getModel();
      if (!model || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
      const name = model.uri.path.split('/').pop()!;
      actions.editFile(name, model.getValue());
    });
    const onTheme = () => monaco.editor.setTheme(themeName());
    dark.addEventListener('change', onTheme);
    return () => {
      dark.removeEventListener('change', onTheme);
      sub.dispose();
      editor.dispose();
    };
  }, []);

  // Show the right model and keep it in sync with the stored content.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    suppress.current = true;
    if (viewing) {
      const model = modelFor(`readonly-${projectId}-${viewing.label.replace(/\W+/g, '-')}`, viewing.name, viewing.content);
      if (model.getValue() !== viewing.content) model.setValue(viewing.content);
      editor.setModel(model);
      editor.updateOptions({ readOnly: true });
    } else {
      const model = modelFor(projectId, activeFile, content);
      if (model.getValue() !== content) model.setValue(content);
      if (editor.getModel() !== model) editor.setModel(model);
      editor.updateOptions({ readOnly: false });
    }
    suppress.current = false;
  }, [projectId, activeFile, viewing, content]);

  // Compiler diagnostics as squiggles.
  useEffect(() => {
    for (const model of monaco.editor.getModels()) {
      if (!model.uri.path.startsWith(`/${projectId}/`)) continue;
      const name = model.uri.path.split('/').pop()!;
      const markers = diagnostics
        .filter((d) => d.file === name && d.severity !== 'note')
        .map((d) => ({
          severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: d.message,
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.line,
          endColumn: model.getLineMaxColumn(Math.min(d.line, model.getLineCount())),
        }));
      monaco.editor.setModelMarkers(model, 'gcc', markers);
    }
  }, [diagnostics, projectId, activeFile]);

  // Highlight the line a fault happened on.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !decorations.current) return;
    const loc = fault ? locations[fault.pc] : undefined;
    const model = editor.getModel();
    const shown = model?.uri.path.split('/').pop();
    if (loc && loc.line > 0 && shown === loc.file) {
      decorations.current.set([
        {
          range: new monaco.Range(loc.line, 1, loc.line, 1),
          options: { isWholeLine: true, className: 'fault-line', glyphMarginClassName: 'fault-glyph' },
        },
      ]);
    } else decorations.current.clear();
  }, [fault, locations, activeFile, viewing]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal) return;
    const t = window.setTimeout(() => {
      editor.revealLineInCenter(reveal.line);
      editor.setPosition({ lineNumber: reveal.line, column: 1 });
      editor.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [reveal]);

  return (
    <div className="editor-wrap">
      {viewing && (
        <div className="readonly-bar">
          <span>
            <strong>{viewing.name}</strong> · {viewing.label} · read-only
          </span>
          <button className="btn btn-small" onClick={() => actions.openFile(activeFile)}>
            Back to my code
          </button>
        </div>
      )}
      <div className="editor-host" ref={host} />
    </div>
  );
}

export function FileTabs() {
  const files = useApp((s) => Object.keys(projectFiles(s)).join('|')).split('|').filter(Boolean);
  const activeFile = useApp((s) => s.activeFile);
  const viewing = useApp((s) => s.viewing);
  const exercise = useApp((s) => currentExercise(s));
  const firmware = useApp((s) => s.firmware);
  const size = useApp((s) => s.build.size);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  const submit = () => {
    const err = actions.addFile(name.trim());
    if (err) setNameError(err);
    else {
      setAdding(false);
      setName('');
      setNameError(null);
    }
  };

  const support = exercise?.support ?? {};
  const required = exercise ? Object.keys(exercise.starter) : ['main.c'];

  return (
    <div className="tabs">
      <div className="tab-list" role="tablist">
        {files.map((f) => (
          <div key={f} className={`tab${!viewing && f === activeFile ? ' active' : ''}`}>
            <button role="tab" aria-selected={!viewing && f === activeFile} onClick={() => actions.openFile(f)}>
              {f}
            </button>
            {!required.includes(f) && (
              <button
                className="tab-close"
                aria-label={`Delete ${f}`}
                title={`Delete ${f}`}
                onClick={() => {
                  if (window.confirm(`Delete ${f}? This cannot be undone.`)) actions.removeFile(f);
                }}
              >
                <Icon name="cross" />
              </button>
            )}
          </div>
        ))}
        {Object.entries(support).map(([f, text]) => (
          <div key={f} className={`tab tab-ro${viewing?.name === f ? ' active' : ''}`}>
            <button role="tab" aria-selected={viewing?.name === f} onClick={() => actions.viewReadOnly(f, text, 'provided with this exercise')} title="Provided file (read-only)">
              {f}
            </button>
          </div>
        ))}
        {adding ? (
          <form
            className="tab-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              autoFocus
              value={name}
              placeholder="sensors.c"
              aria-label="New file name"
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
            />
            <button className="btn btn-small" type="submit">
              Add
            </button>
            {nameError && <span className="field-error">{nameError}</span>}
          </form>
        ) : (
          <button className="tab-add" onClick={() => setAdding(true)} title="Add a .c or .h file" aria-label="Add file">
            <Icon name="plus" />
          </button>
        )}
      </div>
      <div className="tab-actions">
        {size && (
          <span className="size" title="Flash = code + constants + initial values. RAM = globals (stack and heap come on top).">
            Flash {(size.text + size.data).toLocaleString()} B · RAM {(size.data + size.bss).toLocaleString()} B
          </span>
        )}
        <div className="menu-wrap">
          <button className="btn btn-small btn-ghost" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            Chip files <Icon name="chevron" />
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <p className="menu-note">What runs before main(), and where things live in memory. Copy one into your project to change it.</p>
              {Object.entries(firmware).map(([f, text]) => (
                <div key={f} className="menu-row">
                  <button
                    className="menu-item"
                    onClick={() => {
                      setMenu(false);
                      if (files.includes(f)) actions.openFile(f);
                      else actions.viewReadOnly(f, text, 'chip support file');
                    }}
                  >
                    {f}
                  </button>
                  {!files.includes(f) && (
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        setMenu(false);
                        actions.addFile(f, text);
                      }}
                    >
                      Copy to project
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
