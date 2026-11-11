import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/languages/definitions/cpp/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { useEffect, useRef, useState } from 'react';
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
    decorations.current = editor.createDecorationsCollection();
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
