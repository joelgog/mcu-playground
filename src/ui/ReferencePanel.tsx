/**
 * In-app reference: how to find things in the documentation, the source
 * documents, and a bit-level description of every simulated register.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { APP_GUIDE, GUIDE, type Block, type GuideSection } from '../reference/guide';
import { PERIPHERALS, SYMBOLS, type Field, type PeripheralDoc, type RegisterDoc } from '../reference/registers';
import { SOURCES, sourceById } from '../reference/sources';
import { Icon } from './App';
import { Prose } from './panels';
import { actions, useApp } from './store';

/** Name of a register as it is printed in the reference manual. */
export function manualName(periph: PeripheralDoc, reg: RegisterDoc): string {
  const prefix: Record<string, string> = { GPIO: 'GPIOx', TIM: 'TIMx', USART: 'USARTx', SPI: 'SPIx', I2C: 'I2C', SysTick: 'STK' };
  const special: Record<string, string> = { 'SysTick.CTRL': 'STK_CSR', 'SysTick.LOAD': 'STK_RVR', 'SysTick.VAL': 'STK_CVR', 'GPIO.AFR': 'GPIOx_AFRL / GPIOx_AFRH', 'SYSCFG.EXTICR': 'SYSCFG_EXTICR1..4', 'TIM.CCR1': 'TIMx_CCR1..4' };
  return special[`${periph.id}.${reg.name}`] ?? `${prefix[periph.id] ?? periph.id}_${reg.name}`;
}

function cExpr(periph: PeripheralDoc, reg: RegisterDoc): string {
  return `${periph.instances[0]}->${reg.member}`;
}

function Cite({ doc, chapter, extra }: { doc: string; chapter: string; extra?: string }) {
  const s = sourceById(doc);
  return (
    <p className="ref-cite">
      Source: <strong>{s.short}</strong>, chapter “{chapter}”{extra ? `, ${extra}` : ''}.{' '}
      <a href={s.url} target="_blank" rel="noreferrer">
        {s.linkLabel}
      </a>
    </p>
  );
}

/** The register drawn as in a reference manual: 32 bits, most significant first, with named fields. */
function BitStrip({ fields }: { fields: Field[] }) {
  const cells = useMemo(() => {
    const owner: Array<Field | null> = Array<Field | null>(32).fill(null);
    for (const fd of fields) {
      const m = /^(?:(\d+):)?(\d+)$/.exec(fd.bits);
      if (!m) return null;
      const lo = Number(m[2]);
      const hi = m[1] ? Number(m[1]) : lo;
      for (let b = lo; b <= hi; b++) owner[b] = fd;
    }
    // group consecutive bits with the same owner, split at the 16-bit row boundary
    const rows: Array<Array<{ field: Field | null; hi: number; lo: number }>> = [[], []];
    for (const [row, top, bottom] of [[0, 31, 16], [1, 15, 0]] as const) {
      let b = top;
      while (b >= bottom) {
        const fd = owner[b];
        let end = b;
        while (end - 1 >= bottom && owner[end - 1] === fd) end--;
        rows[row].push({ field: fd, hi: b, lo: end });
        b = end - 1;
      }
    }
    return rows;
  }, [fields]);
  if (!cells) return null;
  return (
    <div className="bitstrip" role="img" aria-label="Bit layout of the register">
      {cells.map((row, i) => (
        <div key={i} className="bitrow">
          {row.map((c) => (
            <div key={c.hi} className={`bitcell${c.field ? ' used' : ''}`} style={{ flexGrow: c.hi - c.lo + 1, flexBasis: 0 }} title={c.field ? `${c.field.name}: ${c.field.desc}` : 'reserved'}>
              <span className="bitnum">{c.hi === c.lo ? c.hi : `${c.hi}:${c.lo}`}</span>
              <span className="bitname">{c.field ? c.field.name : ''}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function RegisterCard({ periph, reg, open }: { periph: PeripheralDoc; reg: RegisterDoc; open: boolean }) {
  const el = useRef<HTMLElement>(null);
  useEffect(() => {
    // scroll only the reference pane, never the page
    const node = el.current;
    const pane = node?.closest('.ref-body');
    if (open && node && pane) {
      pane.scrollTo({ top: pane.scrollTop + node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8 });
    }
  }, [open]);
  return (
    <article className={`ref-reg${open ? ' open' : ''}`} ref={el}>
      <button className="ref-reg-head" aria-expanded={open} onClick={() => actions.openReference(periph.id, open ? null : reg.name)}>
        <span className={`caret${open ? ' open' : ''}`}>
          <Icon name="chevron" />
        </span>
        <code className="ref-c">{cExpr(periph, reg)}</code>
        <span className="ref-reg-title">{reg.title}</span>
        <span className="ref-offset">+0x{reg.offset.toString(16).toUpperCase().padStart(2, '0')}</span>
      </button>
      {!open && (
        <p className="ref-reg-what">
          <Rich text={reg.what} />
        </p>
      )}
      {open && (
        <div className="ref-reg-body">
          <BitStrip fields={reg.fields} />
          <h4>What it does</h4>
          <p>
            <Rich text={reg.what} />
          </p>
          <h4>Why and when</h4>
          <p>
            <Rich text={reg.why} />
          </p>
          <h4>Fields</h4>
          <ul className="ref-fieldlist">
            {reg.fields.map((fd) => (
              <li key={fd.name + fd.bits}>
                <div className="ref-field-head">
                  <span className="ref-field-bits">{/^\d+$/.test(fd.bits) ? `bit ${fd.bits}` : `bits ${fd.bits}`}</span>
                  <span className="ref-field-name">{fd.name}</span>
                  <span className="ref-field-macro" title="The name of this field in C">
                    {fd.macro ?? '(1u << n)'}
                  </span>
                </div>
                <p>
                  <Rich text={fd.desc} />
                </p>
              </li>
            ))}
          </ul>
          <Cite doc={periph.source.doc} chapter={periph.source.chapter} extra={`register ${manualName(periph, reg)}`} />
        </div>
      )}
    </article>
  );
}

function PeripheralPage({ periph, openReg }: { periph: PeripheralDoc; openReg: string | null }) {
  return (
    <div className="ref-page">
      <h3>
        {periph.id} <span className="ref-sub">{periph.title}</span>
      </h3>
      <p>
        <Rich text={periph.intro} />
      </p>
      <p className="ref-enable">
        <strong>Switch it on:</strong> <Rich text={periph.enable} />
      </p>
      <p className="ref-instances">
        In C: {periph.instances.map((i) => <code key={i}>{i}</code>).reduce<ReactNode[]>((acc, x, i) => (i ? [...acc, ' ', x] : [x]), [])}
      </p>
      <Cite doc={periph.source.doc} chapter={periph.source.chapter} />
      {periph.registers.map((r) => (
        <RegisterCard key={r.name} periph={periph} reg={r} open={openReg === r.name} />
      ))}
    </div>
  );
}

/** Identifiers that are obviously code: REG->FIELD, ALL_CAPS_MACROS, hex numbers, calls. */
const CODE_TOKEN = /(`[^`]+`|\b[A-Za-z_]\w*->\w+(?:\[\d\])?|\b[A-Z][A-Za-z0-9]*_[A-Z0-9][A-Za-z0-9_]*\b|\b0x[0-9A-Fa-f]+\b|\b[A-Za-z_]\w*\(\))/g;

/** Inline text in which code is set in a code font, whether or not it was marked with backticks. */
export function Rich({ text }: { text: string }) {
  // Find the code tokens, then join neighbours that are only separated by operators,
  // so that a whole expression such as "REG = (REG & ~MASK) | VALUE" is set as one piece.
  const spans: Array<{ start: number; end: number; code: string }> = [];
  for (const m of text.matchAll(CODE_TOKEN)) {
    const token = m[0].startsWith('`') ? m[0].slice(1, -1) : m[0];
    const prev = spans[spans.length - 1];
    const glue = prev ? text.slice(prev.end, m.index) : '';
    if (prev && !m[0].startsWith('`') && glue.length <= 8 && OPERATOR_GLUE.test(glue)) {
      prev.code += glue + token;
      prev.end = m.index + m[0].length;
    } else spans.push({ start: m.index, end: m.index + m[0].length, code: token });
  }
  const parts: ReactNode[] = [];
  let last = 0;
  spans.forEach((s, i) => {
    // a closing parenthesis right after an expression that opened one belongs to it
    if (text[s.end] === ')' && (s.code.match(/\(/g)?.length ?? 0) > (s.code.match(/\)/g)?.length ?? 0)) {
      s.code += ')';
      s.end++;
    }
    if (s.start > last) parts.push(text.slice(last, s.start));
    parts.push(<code key={i}>{s.code}</code>);
    last = s.end;
  });
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Text between two code tokens that makes them one expression: operators, spaces and parentheses only. */
const OPERATOR_GLUE = /^[\s()]*(?:[=|&^~+*-]|<<|>>)[=|&^~<>+*()\s-]*$/;

function GuideBlock({ block }: { block: Block }) {
  switch (block.type) {
    case 'p':
      return <Prose text={block.text} />;
    case 'code':
      return <pre className="ref-code">{block.text}</pre>;
    case 'steps':
      return (
        <ol className="ref-steps">
          {block.items.map((s, i) => (
            <li key={i}>
              <strong>{s.title}</strong>
              <Prose text={s.text} />
              {s.source && (
                <span className="ref-step-source">
                  Look in: <button onClick={() => actions.openReference('docs', null)}>{sourceById(s.source).short}</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      );
    case 'table':
      return (
        <table className="ref-fields ref-guide-table">
          <thead>
            <tr>
              {block.head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>
                    <Prose text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

function GuidePage({ sections }: { sections: GuideSection[] }) {
  return (
    <div className="ref-page">
      {sections.map((s) => (
        <section key={s.id} className="ref-guide">
          <h3>{s.title}</h3>
          {s.blocks.map((b, i) => (
            <GuideBlock key={i} block={b} />
          ))}
        </section>
      ))}
    </div>
  );
}

function DocsPage() {
  return (
    <div className="ref-page">
      <h3>The documents</h3>
      <p>
        These are the primary sources. Everything in this reference is a summary of them, and the bit positions and names are checked automatically against ST's official header file. When the summary
        and the manual disagree, the manual wins.
      </p>
      {SOURCES.map((s) => (
        <article key={s.id} className="ref-doc">
          <h4>
            {s.short} <span className="ref-sub">{s.publisher}</span>
          </h4>
          <p className="ref-doc-title">{s.title}</p>
          <p>{s.use}</p>
          <a href={s.url} target="_blank" rel="noreferrer">
            {s.linkLabel}
          </a>
        </article>
      ))}
      <h3>Core functions</h3>
      {SYMBOLS.map((s) => (
        <article key={s.name} className="ref-doc">
          <h4 className="mono">{s.signature}</h4>
          <p>
            <Rich text={s.desc} />
          </p>
          <Cite doc={s.source.doc} chapter={s.source.chapter} />
        </article>
      ))}
    </div>
  );
}

function SearchResults({ query }: { query: string }) {
  const q = query.trim().toLowerCase();
  const hits = useMemo(() => {
    const out: Array<{ periph: PeripheralDoc; reg: RegisterDoc; why: string }> = [];
    for (const periph of PERIPHERALS) {
      for (const reg of periph.registers) {
        const field = reg.fields.find((fd) => fd.name.toLowerCase().includes(q) || (fd.macro ?? '').toLowerCase().includes(q) || fd.desc.toLowerCase().includes(q));
        const own = `${periph.id} ${periph.instances.join(' ')} ${reg.name} ${reg.title} ${reg.what}`.toLowerCase().includes(q);
        if (own || field) out.push({ periph, reg, why: field && !own ? `${field.name}: ${field.desc}` : reg.what });
      }
    }
    return out.slice(0, 40);
  }, [q]);
  if (hits.length === 0) return <p className="ref-empty">No register, field or macro matches “{query}”.</p>;
  return (
    <div className="ref-page">
      {hits.map(({ periph, reg, why }) => (
        <button key={periph.id + reg.name} className="ref-hit" onClick={() => actions.openReference(periph.id, reg.name)}>
          <code className="ref-c">{cExpr(periph, reg)}</code>
          <span className="ref-reg-title">{reg.title}</span>
          <span className="ref-hit-why">{why}</span>
        </button>
      ))}
    </div>
  );
}

export function ReferencePanel() {
  const ref = useApp((s) => s.reference);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.open && !ref.reg) body.current?.scrollTo({ top: 0 });
  }, [ref.open, ref.topic, ref.reg]);
  if (!ref.open) return null;
  const periph = PERIPHERALS.find((p) => p.id === ref.topic);
  return (
    <aside className="reference" aria-label="Reference">
      <header className="ref-head">
        <h2>Reference</h2>
        <input
          type="search"
          value={ref.query}
          placeholder="Search registers, bits, macros"
          aria-label="Search the reference"
          onChange={(e) => actions.setReferenceQuery(e.target.value)}
        />
        <button className="btn btn-small" onClick={actions.closeReference} title="Back to the board">
          <Icon name="cross" /> Close
        </button>
      </header>
      <nav className="ref-nav" aria-label="Reference sections">
        <button className={ref.topic === 'app' && !ref.query ? 'active' : ''} onClick={() => actions.openReference('app', null)}>
          Using the app
        </button>
        <button className={ref.topic === 'guide' && !ref.query ? 'active' : ''} onClick={() => actions.openReference('guide', null)}>
          Finding registers
        </button>
        <button className={ref.topic === 'docs' && !ref.query ? 'active' : ''} onClick={() => actions.openReference('docs', null)}>
          Documents
        </button>
        <span className="ref-nav-sep" />
        {PERIPHERALS.map((p) => (
          <button key={p.id} className={ref.topic === p.id && !ref.query ? 'active' : ''} onClick={() => actions.openReference(p.id, null)} title={p.title}>
            {p.id}
          </button>
        ))}
      </nav>
      <div className="ref-body" ref={body}>
        {ref.query.trim() ? <SearchResults query={ref.query} /> : periph ? <PeripheralPage periph={periph} openReg={ref.reg} /> : ref.topic === 'docs' ? <DocsPage /> : <GuidePage sections={ref.topic === 'app' ? APP_GUIDE : GUIDE} />}
      </div>
    </aside>
  );
}
