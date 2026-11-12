/**
 * The model solution of the current exercise, explained step by step. Each step
 * gives its reason first; the code stays folded until asked for, so the panel
 * works as a ladder of hints as well as a worked answer.
 */
import { useEffect, useRef, useState } from 'react';
import { walkthroughFor, type SolutionStep } from '../exercises';
import { Icon } from './App';
import { colorize } from './Editor';
import { RefChip } from './panels';
import { Rich } from './ReferencePanel';
import { actions, currentExercise, useApp } from './store';

/** Paragraphs separated by blank lines, with code set in a code font. */
export function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\n+/).map((para, i) => (
        <p key={i}>
          <Rich text={para} />
        </p>
      ))}
    </>
  );
}

/** Syntax-coloured C, falling back to plain text until the colouring is ready. */
export function CodeBlock({ code }: { code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setHtml(null);
    colorize(code).then(
      (h) => live && setHtml(h),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [code]);
  return html ? <pre className="code-block" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="code-block">{code}</pre>;
}

function Step({ step, index, open, onToggle }: { step: SolutionStep; index: number; open: boolean; onToggle: () => void }) {
  return (
    <li className={`sol-step${open ? ' open' : ''}`}>
      <h4>
        <span className="sol-num">{index + 1}</span>
        {step.title}
      </h4>
      <div className="sol-why">
        <Paragraphs text={step.why} />
      </div>
      {open ? (
        <>
          <CodeBlock code={step.code} />
          <div className="sol-how">
            <span className="sol-label">How it works</span>
            <Paragraphs text={step.how} />
          </div>
          {step.refs && step.refs.length > 0 && (
            <div className="sol-refs">
              <span className="sol-label">Look it up</span>
              {step.refs.map((r) => (
                <RefChip key={r} id={r} />
              ))}
            </div>
          )}
          <button className="sol-toggle" onClick={onToggle}>
            Hide the code
          </button>
        </>
      ) : (
        <button className="btn btn-small sol-show" onClick={onToggle}>
          <Icon name="eye" /> Show the code
        </button>
      )}
    </li>
  );
}

export function SolutionPanel() {
  const sol = useApp((s) => s.solution);
  const exercise = useApp((s) => currentExercise(s));
  const running = useApp((s) => s.build.solution && s.build.status === 'ok');
  const building = useApp((s) => s.build.status === 'building');
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShown(new Set());
    body.current?.scrollTo({ top: 0 });
  }, [exercise?.id, sol.open]);

  if (!sol.open || !exercise) return null;
  const w = walkthroughFor(exercise.id);
  const toggle = (i: number) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <aside className="reference solution" aria-label="Solution, step by step">
      <header className="ref-head">
        <h2>Solution, step by step</h2>
        <span className="ref-head-space" />
        <button
          className="btn btn-small"
          onClick={() => {
            setShown(new Set());
            actions.setSolutionReveal(!sol.revealAll);
          }}
        >
          {sol.revealAll ? 'Hide all code' : 'Show all code'}
        </button>
        <button className="btn btn-small" onClick={actions.closeSolution} title="Back to the board">
          <Icon name="cross" /> Close
        </button>
      </header>
      <div className="ref-body" ref={body}>
        <div className="ref-page sol-page">
          <h3>{exercise.title}</h3>

          <section className="sol-idea">
            <span className="sol-label">The idea</span>
            <Paragraphs text={w.idea} />
          </section>

          {!sol.revealAll && (
            <p className="sol-howto">Each step says what has to happen and why. Try to write it yourself first, then open the code to compare.</p>
          )}

          <ol className="sol-steps">
            {w.steps.map((s, i) => (
              <Step key={i} step={s} index={i} open={sol.revealAll || shown.has(i)} onToggle={() => (sol.revealAll ? actions.setSolutionReveal(false) : toggle(i))} />
            ))}
          </ol>

          <h3>Common mistakes</h3>
          <ul className="sol-mistakes">
            {w.mistakes.map((m, i) => (
              <li key={i}>
                <span className="sol-mistake">
                  <Rich text={m.mistake} />
                </span>
                <span className="sol-result">
                  <Rich text={m.result} />
                </span>
              </li>
            ))}
          </ul>

          <h3>How to say it in an interview</h3>
          <blockquote className="sol-say">{w.say}</blockquote>

          <h3>The whole program</h3>
          <p>
            The complete reference solution is the code the checks are tested against. Running it does not change your own code.
            {running ? ' It is running on the board now; Build and run switches back to your code.' : ''}
          </p>
          <div className="sol-actions">
            <button className="btn btn-primary" onClick={() => void actions.runSolution()} disabled={building}>
              <Icon name="play" /> Run the solution on the board
            </button>
            <button className="btn" onClick={actions.viewSolution}>
              Open it in the editor
            </button>
            <button
              className="btn"
              onClick={() => {
                if (window.confirm('Replace your code with the reference solution? Your own version of these files will be lost.')) actions.adoptSolution();
              }}
              title="Use the solution as a starting point for your own experiments"
            >
              Copy it into my code
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
