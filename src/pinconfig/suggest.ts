/** What a pin usually has to be for the part that is wired to it on the playground board. */
import type { DeviceSpec } from '../board/devices';
import { defaultConfig, functionsOf, type PinConfig } from './generate';

export interface Wiring {
  device: DeviceSpec;
  /** The device's name for this connection: "a", "scl", "cs", ... */
  role: string;
}

/** Pin name -> the parts connected to it. Bus pins have several. */
export function wiringOf(devices: DeviceSpec[]): Map<string, Wiring[]> {
  const map = new Map<string, Wiring[]>();
  for (const device of devices) {
    for (const [role, pin] of Object.entries(device.pins)) {
      const list = map.get(pin) ?? [];
      list.push({ device, role });
      map.set(pin, list);
    }
  }
  return map;
}

export interface Suggestion {
  config: PinConfig;
  /** Why this setting fits the part. */
  reason: string;
}

export function suggest(pin: string, wiring: Wiring): Suggestion | null {
  const { device, role } = wiring;
  const base = defaultConfig(pin, device.label);
  const firstAf = functionsOf(pin)[0]?.[0] ?? 0;
  const afNamed = (signal: RegExp) => functionsOf(pin).find(([, s]) => signal.test(s))?.[0] ?? firstAf;
  const output = (reason: string, startHigh = false): Suggestion => ({ config: { ...base, mode: 'output', startHigh }, reason });
  const analog = (reason: string): Suggestion => ({ config: { ...base, mode: 'analog' }, reason });
  const af = (n: number, reason: string, openDrain = false): Suggestion => ({ config: { ...base, mode: 'af', af: n, openDrain }, reason });

  switch (device.kind) {
    case 'led':
    case 'sevenseg':
      return output('The pin drives the LED directly: high lights it.');
    case 'rgb':
      return output('On or off needs a plain output. To mix colours, use the timer function of the pin for PWM.');
    case 'button':
      return device.options?.pullup
        ? { config: { ...base, mode: 'input', pull: 'none' }, reason: 'The board already has a pull-up resistor on this button, so the internal one is not needed.' }
        : { config: { ...base, mode: 'input', pull: 'up' }, reason: 'The button only connects the pin to ground. The pull-up gives it a defined level while the button is open.' };
    case 'pot':
    case 'temp':
    case 'ldr':
      return analog('The part outputs a voltage, which the ADC measures. Analog mode disconnects the digital input.');
    case 'buzzer':
      return af(afNamed(/^TIM/), 'A timer channel produces the tone as a square wave. Its frequency is the pitch.');
    case 'servo':
      return af(afNamed(/^TIM/), 'A timer channel produces the 50 Hz pulse train that sets the angle.');
    case 'motor':
      return role === 'en' ? af(afNamed(/^TIM/), 'PWM from a timer channel sets the motor speed.') : output('A direction input of the motor driver: plain high or low.');
    case 'hcsr04':
      return role === 'trig'
        ? output('The trigger is a short high pulse made in software.')
        : af(afNamed(/^TIM/), 'A timer channel in input-capture mode timestamps the echo edges.');
    case 'console':
      return af(afNamed(/^USART/), role === 'tx' ? 'The USART drives its transmit line through this pin.' : 'The USART listens on this pin.');
    case 'tmp102':
    case 'eeprom':
      return af(afNamed(/^I2C/), 'I2C lines are never driven high: open-drain, with the pull-ups on the board.', true);
    case 'ledbar':
      return role === 'latch' ? output('The latch is pulsed in software after each byte.') : af(afNamed(/^SPI/), 'The SPI peripheral drives clock and data.');
    case 'accel':
      return role === 'cs'
        ? output('Chip select is driven in software. It idles high, because low selects the sensor.', true)
        : af(afNamed(/^SPI/), 'The SPI peripheral owns clock and data lines.');
    default:
      return null;
  }
}
