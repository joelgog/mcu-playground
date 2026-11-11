/**
 * The primary documents an embedded engineer works from, and what each one is for.
 * Citations in the reference point at a document and a chapter title, so they stay
 * valid across document revisions (section numbers shift between revisions).
 */

export interface SourceDoc {
  id: string;
  /** Short name used in citations. */
  short: string;
  title: string;
  publisher: string;
  /** What you look up in this document. */
  use: string;
  url: string;
  /** Where the link leads. */
  linkLabel: string;
}

export const SOURCES: SourceDoc[] = [
  {
    id: 'rm',
    short: 'RM0091',
    title: 'Reference manual RM0091: STM32F0x1 / STM32F0x2 / STM32F0x8 advanced ARM-based 32-bit MCUs',
    publisher: 'STMicroelectronics',
    use:
      'The main document for writing firmware. One chapter per peripheral: how it works, then every register with every bit. ' +
      'This is where names like RCC_AHBENR, GPIOx_MODER and their bit positions are defined.',
    url: 'https://www.st.com/en/microcontrollers-microprocessors/stm32f072rb.html',
    linkLabel: 'ST product page, Documentation tab, Reference manuals',
  },
  {
    id: 'ds',
    short: 'Datasheet',
    title: 'Datasheet STM32F072x8 / STM32F072xB',
    publisher: 'STMicroelectronics',
    use:
      'Everything specific to this exact chip and package: the pinout, the alternate-function table (which pin can be TIM3_CH1, USART2_TX, I2C1_SCL and with which AF number), ' +
      'memory sizes, electrical limits and timing characteristics.',
    url: 'https://www.st.com/resource/en/datasheet/stm32f072rb.pdf',
    linkLabel: 'Datasheet PDF on st.com',
  },
  {
    id: 'pm',
    short: 'PM0215',
    title: 'Programming manual PM0215: STM32F0 series Cortex-M0',
    publisher: 'STMicroelectronics',
    use:
      'The processor core rather than the peripherals: instruction set, registers, exceptions and interrupt handling, and the core peripherals NVIC, SysTick and SCB.',
    url: 'https://www.st.com/en/microcontrollers-microprocessors/stm32f072rb.html',
    linkLabel: 'ST product page, Documentation tab, Programming manuals',
  },
  {
    id: 'arm',
    short: 'Cortex-M0 Generic User Guide',
    title: 'Cortex-M0 Devices Generic User Guide (ARM DUI 0497)',
    publisher: 'Arm',
    use:
      'Arm\'s own description of the Cortex-M0 for software developers: exception model, stack frames, NVIC and SysTick registers, sleep modes. The authority behind PM0215.',
    url: 'https://developer.arm.com/documentation/dui0497/latest/',
    linkLabel: 'developer.arm.com',
  },
  {
    id: 'um',
    short: 'UM1724',
    title: 'User manual UM1724: STM32 Nucleo-64 boards (MB1136)',
    publisher: 'STMicroelectronics',
    use:
      'The board, not the chip: which MCU pin is wired to the user LED (PA5), the user button (PC13), the virtual COM port (PA2 / PA3) and each connector pin. ' +
      'The playground board follows the Nucleo-F072RB for these and adds its own devices on free pins.',
    url: 'https://www.st.com/en/evaluation-tools/nucleo-f072rb.html',
    linkLabel: 'Nucleo-F072RB page, Documentation tab',
  },
  {
    id: 'cmsis',
    short: 'CMSIS header',
    title: 'CMSIS device header stm32f072xb.h and core header core_cm0.h',
    publisher: 'STMicroelectronics / Arm',
    use:
      'The reference manual in C form. It declares one struct per peripheral (so RCC->AHBENR compiles) and one macro per bit (RCC_AHBENR_GPIOAEN). ' +
      'When you know the register and bit name from the manual, the header gives you the exact spelling. In this project: firmware/cmsis/.',
    url: 'https://github.com/STMicroelectronics/cmsis-device-f0',
    linkLabel: 'ST CMSIS device repository on GitHub',
  },
  {
    id: 'i2c',
    short: 'UM10204',
    title: 'I2C-bus specification and user manual UM10204',
    publisher: 'NXP Semiconductors',
    use: 'The bus protocol itself: START and STOP conditions, addressing, acknowledge, clock stretching, speed grades and pull-up sizing.',
    url: 'https://www.nxp.com/docs/en/user-guide/UM10204.pdf',
    linkLabel: 'PDF on nxp.com',
  },
  {
    id: 'tmp102',
    short: 'TMP102 datasheet',
    title: 'TMP102 low-power digital temperature sensor',
    publisher: 'Texas Instruments',
    use: 'Register map and data format of the I2C temperature sensor (pointer register, 12-bit temperature, 0.0625 C per count). The simulated sensor is a simplified model of it.',
    url: 'https://www.ti.com/product/TMP102',
    linkLabel: 'Product page on ti.com',
  },
  {
    id: 'eeprom',
    short: '24LC02B datasheet',
    title: '24AA02 / 24LC02B 2-Kbit I2C serial EEPROM',
    publisher: 'Microchip Technology',
    use: 'Byte and page write, the 5 ms write cycle and acknowledge polling, random and sequential read. The simulated EEPROM is a simplified model of it.',
    url: 'https://www.microchip.com/en-us/product/24LC02B',
    linkLabel: 'Product page on microchip.com',
  },
  {
    id: 'hc595',
    short: 'SN74HC595 datasheet',
    title: 'SN74HC595 8-bit shift register with 3-state output registers',
    publisher: 'Texas Instruments',
    use: 'Timing of the serial input, the shift clock and the storage (latch) clock. Explains why data needs SPI mode 0 or 3 and why the outputs only change on the latch edge.',
    url: 'https://www.ti.com/product/SN74HC595',
    linkLabel: 'Product page on ti.com',
  },
  {
    id: 'lis3dh',
    short: 'LIS3DH datasheet',
    title: 'LIS3DH MEMS digital output motion sensor',
    publisher: 'STMicroelectronics',
    use: 'SPI protocol (read and auto-increment bits), register map (WHO_AM_I, CTRL_REG1, OUT_X_L ...) and data format. The simulated accelerometer is a simplified model of it.',
    url: 'https://www.st.com/en/mems-and-sensors/lis3dh.html',
    linkLabel: 'Product page on st.com',
  },
  {
    id: 'mcp9700',
    short: 'MCP9700 datasheet',
    title: 'MCP9700 / MCP9700A low-power linear active thermistor IC',
    publisher: 'Microchip Technology',
    use: 'Transfer function of the analog temperature sensor: 500 mV at 0 C and 10 mV per degree.',
    url: 'https://www.microchip.com/en-us/product/MCP9700',
    linkLabel: 'Product page on microchip.com',
  },
];

export function sourceById(id: string): SourceDoc {
  const s = SOURCES.find((d) => d.id === id);
  if (!s) throw new Error(`Unknown source ${id}`);
  return s;
}
