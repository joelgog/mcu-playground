/** Plays a list of timed steps (pin changes) through the simulation clock, then calls a completion handler. */
import { Clock, SimEvent } from '../clock';

export class WaveSeq {
  private steps: Array<{ dt: number; fn: () => void }> = [];
  private ev: SimEvent | null = null;

  constructor(private clock: Clock) {}

  /** Wait dt cycles after the previous step, then run fn. */
  add(dt: number, fn: () => void): this {
    this.steps.push({ dt, fn });
    return this;
  }

  /** Just wait. */
  wait(dt: number): this {
    return this.add(dt, () => {});
  }

  get busy(): boolean {
    return this.ev !== null;
  }

  run(done: () => void): void {
    const steps = this.steps;
    this.steps = [];
    let i = 0;
    let at = this.clock.time();
    const next = (): void => {
      // run every step that is due now (dt = 0 steps chain immediately)
      while (i < steps.length) {
        const s = steps[i];
        if (s.dt > 0) {
          at += s.dt;
          const fn = s.fn;
          i++;
          this.ev = this.clock.schedule(at, () => {
            fn();
            next();
          });
          return;
        }
        s.fn();
        i++;
      }
      this.ev = null;
      done();
    };
    this.ev = this.clock.schedule(at, next);
  }

  cancel(): void {
    this.clock.cancel(this.ev);
    this.ev = null;
    this.steps = [];
  }
}
