import { bitMasks, debounce, helloGpio, systickTimebase } from './set1';
import { exti, pwmDim, servoPot, timerIrq } from './set2';
import { sharedData, sonar, thermostat, trafficLight } from './set3';
import { cDrills, lowPower, uartEcho, watchdog } from './set4';
import { Exercise } from './types';

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
  cDrills,
];

export function exerciseById(id: string): Exercise | undefined {
  return EXERCISES.find((e) => e.id === id);
}

export type { CheckResult, Exercise } from './types';
