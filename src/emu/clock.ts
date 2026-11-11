/**
 * Simulation clock and event queue.
 *
 * Time is counted in CPU (HCLK) cycles. Peripherals and board devices schedule
 * callbacks at absolute cycle times; the CPU run loop executes everything that
 * is due before each instruction.
 */

export interface SimEvent {
  at: number;
  seq: number;
  fn: (at: number) => void;
  cancelled: boolean;
  /** Wall-clock deadline in seconds for events that must survive a clock-speed change. */
  wallAt: number;
}

export class Clock {
  /** CPU cycles since power-on. */
  cycles = 0;
  /** Cycle time of the earliest pending event (Infinity if none). */
  nextEventAt = Infinity;
  /** Current HCLK frequency in Hz. */
  hz = 8_000_000;

  private baseSec = 0;
  private baseCycles = 0;
  private heap: SimEvent[] = [];
  private seq = 0;
  private eventAt = -1;

  /** Current time in cycles; inside an event callback this is the event's nominal time. */
  time(): number {
    return this.eventAt >= 0 ? this.eventAt : this.cycles;
  }

  /** Current time in seconds. */
  seconds(): number {
    return this.toSeconds(this.time());
  }

  toSeconds(cycles: number): number {
    return this.baseSec + (cycles - this.baseCycles) / this.hz;
  }

  toCycles(seconds: number): number {
    return this.baseCycles + (seconds - this.baseSec) * this.hz;
  }

  schedule(at: number, fn: (at: number) => void, wallAt = NaN): SimEvent {
    const ev: SimEvent = { at, seq: this.seq++, fn, cancelled: false, wallAt };
    this.push(ev);
    if (at < this.nextEventAt) this.nextEventAt = at;
    return ev;
  }

  scheduleIn(deltaCycles: number, fn: (at: number) => void): SimEvent {
    return this.schedule(this.time() + deltaCycles, fn);
  }

  /** Schedule relative to now in seconds of simulated time (independent of later clock changes). */
  scheduleSec(deltaSec: number, fn: (at: number) => void): SimEvent {
    const wall = this.seconds() + deltaSec;
    return this.schedule(Math.ceil(this.toCycles(wall)), fn, wall);
  }

  cancel(ev: SimEvent | null | undefined): void {
    if (ev) ev.cancelled = true;
  }

  /** Run all events with at <= cycles. */
  runDue(): void {
    const heap = this.heap;
    while (heap.length > 0 && heap[0].at <= this.cycles) {
      const ev = this.pop();
      if (ev.cancelled) continue;
      this.eventAt = ev.at;
      try {
        ev.fn(ev.at);
      } finally {
        this.eventAt = -1;
      }
    }
    this.nextEventAt = heap.length > 0 ? heap[0].at : Infinity;
  }

  /** Change the HCLK frequency; wall-clock events keep their real-time deadline. */
  setHz(hz: number): void {
    if (hz === this.hz || hz <= 0) return;
    const now = this.time();
    this.baseSec = this.toSeconds(now);
    this.baseCycles = now;
    this.hz = hz;
    const old = this.heap;
    this.heap = [];
    for (const ev of old) {
      if (ev.cancelled) continue;
      if (!Number.isNaN(ev.wallAt)) ev.at = Math.max(now, Math.ceil(this.toCycles(ev.wallAt)));
      this.push(ev);
    }
    this.nextEventAt = this.heap.length > 0 ? this.heap[0].at : Infinity;
  }

  private less(a: SimEvent, b: SimEvent): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }

  private push(ev: SimEvent): void {
    const h = this.heap;
    let i = h.length;
    h.push(ev);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      const t = h[i];
      h[i] = h[p];
      h[p] = t;
      i = p;
    }
  }

  private pop(): SimEvent {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        const t = h[i];
        h[i] = h[m];
        h[m] = t;
        i = m;
      }
    }
    return top;
  }
}
