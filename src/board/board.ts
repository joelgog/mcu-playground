/** The playground board: which devices are fitted and which MCU pins they use. */
import { Mcu } from '../emu/mcu';
import { Button, Device, DeviceSpec, DeviceState, SerialConsole, createDevice } from './devices';
import { NetProbe } from './net';

export const STANDARD_DEVICES: DeviceSpec[] = [
  { id: 'ld2', kind: 'led', label: 'On-board LED', ref: 'LD2', pins: { a: 'PA5' }, options: { color: 'green' } },
  { id: 'b1', kind: 'button', label: 'On-board button', ref: 'B1', pins: { a: 'PC13' }, options: { pullup: true, bounceMs: 0 } },
  { id: 'console', kind: 'console', label: 'Serial console', ref: 'J1', pins: { tx: 'PA2', rx: 'PA3' } },
  { id: 'led_red', kind: 'led', label: 'Red LED', ref: 'D1', pins: { a: 'PC8' }, options: { color: 'red' } },
  { id: 'led_yellow', kind: 'led', label: 'Yellow LED', ref: 'D2', pins: { a: 'PC9' }, options: { color: 'yellow' } },
  { id: 'led_green', kind: 'led', label: 'Green LED', ref: 'D3', pins: { a: 'PC10' }, options: { color: 'green' } },
  { id: 'led_blue', kind: 'led', label: 'Blue LED', ref: 'D4', pins: { a: 'PC11' }, options: { color: 'blue' } },
  { id: 'rgb', kind: 'rgb', label: 'RGB LED', ref: 'D5', pins: { r: 'PB4', g: 'PB5', b: 'PB0' } },
  { id: 'sw1', kind: 'button', label: 'Button A', ref: 'SW1', pins: { a: 'PB8' }, options: { bounceMs: 5 } },
  { id: 'sw2', kind: 'button', label: 'Button B', ref: 'SW2', pins: { a: 'PB9' }, options: { bounceMs: 5 } },
  { id: 'pot', kind: 'pot', label: 'Potentiometer', ref: 'RV1', pins: { wiper: 'PA0' } },
  { id: 'temp', kind: 'temp', label: 'Temperature sensor', ref: 'U2', pins: { out: 'PA1' } },
  { id: 'ldr', kind: 'ldr', label: 'Light sensor', ref: 'R9', pins: { out: 'PA6' } },
  { id: 'buzzer', kind: 'buzzer', label: 'Buzzer', ref: 'BZ1', pins: { signal: 'PA4' } },
  { id: 'servo', kind: 'servo', label: 'Servo', ref: 'M1', pins: { signal: 'PB10' } },
  { id: 'motor', kind: 'motor', label: 'DC motor', ref: 'M2', pins: { en: 'PA7', in1: 'PB14', in2: 'PB15' } },
  { id: 'sonar', kind: 'hcsr04', label: 'Distance sensor', ref: 'U3', pins: { trig: 'PA8', echo: 'PB3' } },
  {
    id: 'seg', kind: 'sevenseg', label: '7-segment display', ref: 'DS1',
    pins: { a: 'PC0', b: 'PC1', c: 'PC2', d: 'PC3', e: 'PC4', f: 'PC5', g: 'PC6', dp: 'PC7' },
  },
];

export interface NetSnapshot {
  v: number;
  level: number;
  floating: boolean;
  contention: boolean;
  /** Fraction of the last frame spent high. */
  duty: number;
  /** Rising edges per second during the last frame. */
  freq: number;
  /** Register-level description of the MCU pin configuration. */
  config: string;
}

export interface BoardSnapshot {
  devices: Record<string, DeviceState>;
  nets: Record<string, NetSnapshot>;
}

export class Board {
  readonly devices = new Map<string, Device>();
  readonly specs: DeviceSpec[];
  private probes = new Map<string, NetProbe>();

  /** Fit the given devices (default: the full standard board) to the MCU. */
  constructor(
    readonly mcu: Mcu,
    deviceIds?: string[],
    overrides: Record<string, Record<string, number | string | boolean>> = {},
  ) {
    this.specs = STANDARD_DEVICES.filter((d) => !deviceIds || deviceIds.includes(d.id)).map((d) => ({
      ...d,
      options: { ...d.options, ...overrides[d.id] },
    }));
    for (const spec of this.specs) {
      this.devices.set(spec.id, createDevice(spec, mcu));
      for (const pin of Object.values(spec.pins)) {
        if (!this.probes.has(pin)) this.probes.set(pin, new NetProbe(mcu.net(pin)));
      }
    }
  }

  device<T extends Device = Device>(id: string): T {
    const d = this.devices.get(id);
    if (!d) throw new Error(`This board has no device "${id}"`);
    return d as T;
  }

  button(id: string): Button {
    return this.device<Button>(id);
  }

  get console(): SerialConsole | null {
    return (this.devices.get('console') as SerialConsole | undefined) ?? null;
  }

  input(id: string, name: string, value: number): void {
    this.devices.get(id)?.input(name, value);
  }

  /** Pins used by this board, in a stable order. */
  pins(): string[] {
    return [...this.probes.keys()];
  }

  snapshot(): BoardSnapshot {
    const devices: Record<string, DeviceState> = {};
    for (const [id, d] of this.devices) devices[id] = d.state();
    const nets: Record<string, NetSnapshot> = {};
    for (const [pin, probe] of this.probes) {
      const net = this.mcu.net(pin);
      const r = probe.read();
      const port = this.mcu.ports.get(pin[1])!;
      nets[pin] = {
        v: net.v,
        level: net.level,
        floating: net.floating,
        contention: net.contention,
        duty: r.duty,
        freq: r.freq,
        config:
          (this.mcu.rcc.ahbenr >>> (17 + port.index)) & 1
            ? port.describe(Number(pin.slice(2)))
            : `GPIO${port.letter} clock is off (pin is a floating input)`,
      };
    }
    return { devices, nets };
  }
}
