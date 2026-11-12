import { EXPLAIN_1 } from './explain1';
import { EXPLAIN_2 } from './explain2';
import { bitMasks, debounce, helloGpio, systickTimebase } from './set1';
import { exti, pwmDim, servoPot, timerIrq } from './set2';
import { sharedData, sonar, thermostat, trafficLight } from './set3';
import { cDrills, lowPower, uartEcho, watchdog } from './set4';
import { i2cSensor, spiAccel, spiLeds } from './set5';
import { Exercise, Walkthrough } from './types';

export const EXERCISES: Exercise[] = [
  helloGpio,
  bitMasks,
  systickTimebase,
  debounce,
  exti,
  timerIrq,
  pwmDim,
  servoPot,
  thermostat,
  sonar,
  sharedData,
  trafficLight,
  watchdog,
  uartEcho,
  lowPower,
  i2cSensor,
  spiLeds,
  spiAccel,
  cDrills,
];

/** The exercises by topic, in the order they are listed. */
export const GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: 'GPIO basics', ids: ['hello-gpio', 'bit-masks'] },
  { title: 'Time and interrupts', ids: ['systick', 'debounce', 'exti', 'timer-irq'] },
  { title: 'PWM, ADC and capture', ids: ['pwm', 'servo', 'thermostat', 'input-capture'] },
  { title: 'Firmware design', ids: ['shared-data', 'state-machine', 'watchdog', 'uart', 'low-power'] },
  { title: 'Buses', ids: ['i2c-sensor', 'spi-shift-register', 'spi-accelerometer'] },
  { title: 'C on a whiteboard', ids: ['c-drills'] },
];

const WALKTHROUGHS: Record<string, Walkthrough> = { ...EXPLAIN_1, ...EXPLAIN_2 };

export function exerciseById(id: string): Exercise | undefined {
  return EXERCISES.find((e) => e.id === id);
}

/** The explained model solution of an exercise. */
export function walkthroughFor(id: string): Walkthrough {
  const w = WALKTHROUGHS[id];
  if (!w) throw new Error(`No explained solution for exercise "${id}"`);
  return w;
}

export type { CheckResult, Exercise, SolutionStep, Walkthrough } from './types';
