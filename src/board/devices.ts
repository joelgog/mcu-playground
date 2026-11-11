/**
 * Board devices: the sensors and actuators wired to the MCU pins.
 *
 * Each device attaches to one or more nets, drives them (sensors, buttons) or
 * observes them (LEDs, servo, motor...), and reports a plain-object state for the UI.
 */
import { Clock, SimEvent } from '../emu/clock';
import { Mcu } from '../emu/mcu';
import { Net, NetProbe, VDD } from './net';

export type DeviceKind =
  | 'led' | 'rgb' | 'button' | 'pot' | 'temp' | 'ldr' | 'servo' | 'motor' | 'buzzer' | 'hcsr04' | 'sevenseg' | 'console';

export interface DeviceSpec {
  id: string;
  kind: DeviceKind;
  /** Plain-language name shown by default, e.g. "Red LED". */
  label: string;
  /** Schematic designator, e.g. "D3". */
  ref: string;
  /** Role -> MCU pin name. */
  pins: Record<string, string>;
  options?: Record<string, number | string | boolean>;
}

export type DeviceState = Record<string, number | string | boolean | number[]>;

export abstract class Device {
  protected readonly clock: Clock;
  constructor(
    readonly spec: DeviceSpec,
    protected readonly mcu: Mcu,
  ) {
    this.clock = mcu.clock;
    for (const pin of Object.values(spec.pins)) mcu.net(pin).attached.push(spec.label);
  }
  protected net(role: string): Net {
    return this.mcu.net(this.spec.pins[role]);
  }
  protected opt<T extends number | string | boolean>(name: string, fallback: T): T {
    const v = this.spec.options?.[name];
    return (v === undefined ? fallback : v) as T;
  }
  abstract state(): DeviceState;
  /** Stimulus from the user or a test script. */
  input(_name: string, _value: number): void {}
  /** Called when the MCU is reset (devices keep their physical state by default). */
  mcuReset(): void {}
}

// ------------------------------------------------------------------ LED

export class Led extends Device {
  private probe: NetProbe;
  private activeLow: boolean;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.probe = new NetProbe(this.net('a'));
    this.activeLow = this.opt('activeLow', false);
  }
  /** Is the LED lit right now? */
  lit(): boolean {
    const n = this.net('a');
    return n.driven && (n.level === 1) !== this.activeLow;
  }
  state(): DeviceState {
    const n = this.net('a');
    const r = this.probe.read();
    const duty = this.activeLow ? 1 - r.duty : r.duty;
    return { brightness: n.driven || r.freq > 0 ? duty : 0, on: this.lit(), color: this.opt('color', 'green'), freq: r.freq };
  }
}

export class RgbLed extends Device {
  private probes: NetProbe[];
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.probes = ['r', 'g', 'b'].map((c) => new NetProbe(this.net(c)));
  }
  state(): DeviceState {
    const [r, g, b] = this.probes.map((p, i) => {
      const n = this.net('rgb'[i]);
      const reading = p.read();
      return n.driven || reading.freq > 0 ? reading.duty : 0;
    });
    return { r, g, b };
  }
}

// --------------------------------------------------------------- button

/** Small deterministic PRNG so that contact bounce is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class Button extends Device {
  pressed = false;
  bounceMs: number;
  private contact = false;
  private externalPullup: boolean;
  private events: SimEvent[] = [];
  private rand: () => number;
  /** Number of clean press actions so far (for checks). */
  presses = 0;

  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.bounceMs = this.opt('bounceMs', 0);
    this.externalPullup = this.opt('pullup', false);
    this.rand = lcg(0xb0c0 + spec.id.length * 977 + spec.id.charCodeAt(spec.id.length - 1));
    if (!this.externalPullup) this.net('a').floatHint = spec.label;
    this.apply();
  }

  private apply(): void {
    // The switch connects the pin to GND; an external pull-up (if fitted) holds it high otherwise.
    this.net('a').drive(this, this.contact ? 0 : null, this.externalPullup ? VDD : null);
  }

  private setContact(closed: boolean): void {
    this.contact = closed;
    this.apply();
  }

  /** Press or release; the contact chatters for bounceMs before it settles. */
  set(pressed: boolean): void {
    if (pressed === this.pressed) return;
    this.pressed = pressed;
    if (pressed) this.presses++;
    for (const e of this.events) this.clock.cancel(e);
    this.events = [];
    this.setContact(pressed);
    if (this.bounceMs <= 0) return;
    const span = this.bounceMs / 1000;
    const toggles = 2 * (2 + Math.floor(this.rand() * 4)); // even count: ends in the new state
    const times: number[] = [];
    for (let i = 0; i < toggles; i++) times.push(span * (0.05 + 0.9 * this.rand()));
    times.sort((a, b) => a - b);
    let state = pressed;
    for (const t of times) {
      state = !state;
      const s = state;
      this.events.push(this.clock.scheduleSec(t, () => this.setContact(s)));
    }
  }

  input(name: string, value: number): void {
    if (name === 'pressed') this.set(value !== 0);
    else if (name === 'bounceMs') this.bounceMs = Math.max(0, value);
  }

  state(): DeviceState {
    return { pressed: this.pressed, bounceMs: this.bounceMs, pullup: this.externalPullup };
  }
}

// ------------------------------------------------------- analog sources

export class Pot extends Device {
  pos: number;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.pos = this.opt('pos', 0.5);
    this.apply();
  }
  private apply(): void {
    this.net('wiper').drive(this, VDD * this.pos);
  }
  input(name: string, value: number): void {
    if (name === 'pos') {
      this.pos = Math.max(0, Math.min(1, value));
      this.apply();
    }
  }
  state(): DeviceState {
    return { pos: this.pos, volts: VDD * this.pos };
  }
}

/** Analog temperature sensor, MCP9700 style: 500 mV at 0 C, 10 mV per degree. */
export class TempSensor extends Device {
  tempC: number;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.tempC = this.opt('tempC', 22);
    this.apply();
  }
  volts(): number {
    return Math.max(0, Math.min(VDD, 0.5 + 0.01 * this.tempC));
  }
  private apply(): void {
    this.net('out').drive(this, this.volts());
  }
  input(name: string, value: number): void {
    if (name === 'tempC') {
      this.tempC = Math.max(-40, Math.min(125, value));
      this.apply();
    }
  }
  state(): DeviceState {
    return { tempC: this.tempC, volts: this.volts() };
  }
}

/** Light sensor: photoresistor in a divider; brighter light gives a higher voltage. */
export class Ldr extends Device {
  light: number;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.light = this.opt('light', 0.5);
    this.apply();
  }
  volts(): number {
    // 10k fixed resistor to GND, LDR to 3V3: 200 ohm in bright light .. 200k in darkness (log scale)
    const rLdr = 200_000 * Math.pow(10, -3 * this.light);
    return (VDD * 10_000) / (10_000 + rLdr);
  }
  private apply(): void {
    this.net('out').drive(this, this.volts());
  }
  input(name: string, value: number): void {
    if (name === 'light') {
      this.light = Math.max(0, Math.min(1, value));
      this.apply();
    }
  }
  state(): DeviceState {
    return { light: this.light, volts: this.volts() };
  }
}

// ------------------------------------------------------------ actuators

/** Hobby servo: 50 Hz signal, 1.0 ms pulse = 0 degrees, 1.5 ms = 90, 2.0 ms = 180. */
export class Servo extends Device {
  private probe: NetProbe;
  angle = 90;
  target = 90;
  private lastUpdate: number;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.probe = new NetProbe(this.net('signal'));
    this.lastUpdate = this.clock.seconds();
  }
  /** Signal measured on the control pin. */
  signal(): { valid: boolean; pulseMs: number; periodMs: number } {
    const now = this.clock.seconds();
    const pulseMs = this.probe.lastHighSec * 1000;
    const periodMs = this.probe.lastPeriodSec * 1000;
    const fresh = this.probe.lastRise >= 0 && now - this.probe.lastRise < 0.1;
    const valid = fresh && periodMs >= 5 && periodMs <= 30 && pulseMs >= 0.4 && pulseMs <= 2.6;
    return { valid, pulseMs, periodMs };
  }
  private update(): { valid: boolean; pulseMs: number; periodMs: number } {
    const sig = this.signal();
    const now = this.clock.seconds();
    if (sig.valid) this.target = Math.max(0, Math.min(180, (sig.pulseMs - 1.0) * 180));
    const maxStep = 400 * (now - this.lastUpdate); // degrees per second
    this.lastUpdate = now;
    if (sig.valid) {
      const d = this.target - this.angle;
      this.angle += Math.max(-maxStep, Math.min(maxStep, d));
    }
    return sig;
  }
  state(): DeviceState {
    const sig = this.update();
    this.probe.read();
    return { angle: this.angle, target: this.target, pulseMs: sig.pulseMs, periodMs: sig.periodMs, valid: sig.valid };
  }
}

/** DC motor on an H-bridge: PWM on the enable pin sets the speed, IN1/IN2 set the direction. */
export class Motor extends Device {
  private probe: NetProbe;
  speed = 0;
  private lastUpdate: number;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.probe = new NetProbe(this.net('en'));
    this.lastUpdate = this.clock.seconds();
  }
  state(): DeviceState {
    const en = this.net('en');
    const r = this.probe.read();
    const duty = en.driven || r.freq > 0 ? r.duty : 0;
    const in1 = this.net('in1');
    const in2 = this.net('in2');
    const a = in1.driven ? in1.level : 0;
    const b = in2.driven ? in2.level : 0;
    const dir = a - b;
    const target = duty * dir;
    const now = this.clock.seconds();
    const k = 1 - Math.exp(-(now - this.lastUpdate) / 0.25);
    this.lastUpdate = now;
    this.speed += (target - this.speed) * k;
    return { speed: this.speed, duty, dir, brake: a === 1 && b === 1, freq: r.freq };
  }
}

export class Buzzer extends Device {
  private probe: NetProbe;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.probe = new NetProbe(this.net('signal'));
  }
  state(): DeviceState {
    const r = this.probe.read();
    const freq = r.lastPeriodSec > 0 && this.clock.seconds() - this.probe.lastRise < 0.05 ? 1 / r.lastPeriodSec : 0;
    return { freq, on: freq >= 20 && freq <= 20000, duty: r.duty };
  }
}

/**
 * HC-SR04 ultrasonic distance sensor. A trigger pulse of at least 10 us starts a
 * measurement; the echo pin then goes high for 58 us per centimetre of distance.
 */
export class Hcsr04 extends Device {
  distanceCm: number;
  private trigRise = -1;
  private busy = false;
  measurements = 0;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.distanceCm = this.opt('distanceCm', 50);
    this.net('echo').drive(this, 0);
    let last = this.net('trig').level;
    this.net('trig').onChange((n) => {
      if (n.level === last) return;
      last = n.level;
      const t = this.clock.seconds();
      if (n.level) this.trigRise = t;
      else if (this.trigRise >= 0) this.trigger(t - this.trigRise);
    });
  }
  private trigger(widthSec: number): void {
    if (this.busy) return;
    if (widthSec < 9.5e-6) {
      this.mcu.addHint(
        `hcsr04:${this.spec.id}`,
        `The trigger pulse for the ${this.spec.label} was only ${(widthSec * 1e6).toFixed(1)} us long; the sensor needs at least 10 us.`,
      );
      return;
    }
    this.busy = true;
    this.measurements++;
    const echoSec = this.distanceCm > 400 ? 0.038 : this.distanceCm * 58e-6;
    this.clock.scheduleSec(0.00046, () => {
      this.net('echo').drive(this, VDD);
      this.clock.scheduleSec(echoSec, () => {
        this.net('echo').drive(this, 0);
        this.clock.scheduleSec(0.0002, () => {
          this.busy = false;
        });
      });
    });
  }
  input(name: string, value: number): void {
    if (name === 'distanceCm') this.distanceCm = Math.max(2, Math.min(450, value));
  }
  state(): DeviceState {
    return { distanceCm: this.distanceCm, busy: this.busy, measurements: this.measurements };
  }
}

const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];
const DIGITS: Record<number, string> = {
  0x3f: '0', 0x06: '1', 0x5b: '2', 0x4f: '3', 0x66: '4', 0x6d: '5', 0x7d: '6', 0x07: '7', 0x7f: '8', 0x6f: '9',
  0x77: 'A', 0x7c: 'b', 0x39: 'C', 0x5e: 'd', 0x79: 'E', 0x71: 'F', 0x00: ' ', 0x40: '-',
};

/** Single-digit common-cathode 7-segment display: a segment lights when its pin drives high. */
export class SevenSeg extends Device {
  private probes: NetProbe[];
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.probes = SEGMENTS.map((s) => new NetProbe(this.net(s)));
  }
  /** Bit mask of lit segments (bit 0 = a ... bit 6 = g, bit 7 = dp). */
  mask(): number {
    let m = 0;
    SEGMENTS.forEach((s, i) => {
      const n = this.net(s);
      if (n.driven && n.level) m |= 1 << i;
    });
    return m;
  }
  /** The character currently shown, or '?' if the pattern is not a hex digit. */
  char(): string {
    return DIGITS[this.mask() & 0x7f] ?? '?';
  }
  state(): DeviceState {
    const segments = this.probes.map((p, i) => {
      const n = this.net(SEGMENTS[i]);
      const r = p.read();
      return n.driven || r.freq > 0 ? r.duty : 0;
    });
    return { segments, char: this.char() };
  }
}

/** Serial terminal on USART2 (PA2 = MCU TX, PA3 = MCU RX), fixed at 115200 baud 8N1. */
export class SerialConsole extends Device {
  readonly baud = 115200;
  /** Everything received since power-on. */
  text = '';
  onText: (chunk: string) => void = () => {};
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.net('rx').drive(this, null, VDD); // idle level of the console's transmit line
    mcu.usart2.onTx = (byte, baud) => {
      let ch: string;
      if (Math.abs(baud - this.baud) / this.baud > 0.035) {
        ch = '�';
        mcu.addHint(
          'console:baud',
          `The serial console expects ${this.baud} baud, but USART2 is sending at about ${Math.round(baud)} baud, so the text is garbled. ` +
            `Check USART2->BRR (and SystemCoreClock if you changed the clock).`,
        );
      } else ch = String.fromCharCode(byte);
      this.text += ch;
      if (this.text.length > 200_000) this.text = this.text.slice(-100_000);
      this.onText(ch);
    };
  }
  /** Type text into the console: it is sent to the MCU's RX pin. */
  send(text: string): void {
    for (let i = 0; i < text.length; i++) this.mcu.usart2.receive(text.charCodeAt(i) & 0xff, this.baud);
  }
  state(): DeviceState {
    return { baud: this.baud };
  }
}

export function createDevice(spec: DeviceSpec, mcu: Mcu): Device {
  switch (spec.kind) {
    case 'led': return new Led(spec, mcu);
    case 'rgb': return new RgbLed(spec, mcu);
    case 'button': return new Button(spec, mcu);
    case 'pot': return new Pot(spec, mcu);
    case 'temp': return new TempSensor(spec, mcu);
    case 'ldr': return new Ldr(spec, mcu);
    case 'servo': return new Servo(spec, mcu);
    case 'motor': return new Motor(spec, mcu);
    case 'buzzer': return new Buzzer(spec, mcu);
    case 'hcsr04': return new Hcsr04(spec, mcu);
    case 'sevenseg': return new SevenSeg(spec, mcu);
    case 'console': return new SerialConsole(spec, mcu);
  }
}
