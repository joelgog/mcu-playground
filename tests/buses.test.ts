/** I2C and SPI peripherals with their board devices, exercised with real firmware. */
import { describe, expect, it } from 'vitest';
import { compile } from '../server/toolchain';
import { Board } from '../src/board/board';
import { Accel, Eeprom, LedBar, Tmp102 } from '../src/board/busDevices';
import { Net } from '../src/board/net';
import { Mcu } from '../src/emu/mcu';

async function boot(main: string, devices: string[]): Promise<{ mcu: Mcu; board: Board }> {
  const res = await compile([{ name: 'main.c', content: `#include "stm32f0xx.h"\n${main}` }], { opt: 'Og' });
  if (!res.ok || !res.elf) throw new Error(res.log);
  const mcu = new Mcu();
  const board = new Board(mcu, devices);
  mcu.load(res.elf);
  return { mcu, board };
}

function rises(net: Net): number[] {
  const out: number[] = [];
  for (let i = 1; i < net.traceT.length; i++) {
    if (net.traceV[i] > 1.65 && net.traceV[i - 1] <= 1.65) out.push(net.traceT[i]);
  }
  return out;
}
const hintIds = (mcu: Mcu) => mcu.hints.map((h) => h.id);

const I2C = (otyper = 'GPIOB->OTYPER |= GPIO_OTYPER_OT_6 | GPIO_OTYPER_OT_7;') => `
static void i2c_init(void) {
  RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
  RCC->APB1ENR |= RCC_APB1ENR_I2C1EN;
  GPIOB->MODER |= GPIO_MODER_MODER6_1 | GPIO_MODER_MODER7_1;
  ${otyper}
  GPIOB->AFR[0] |= (1u << 24) | (1u << 28);        /* PB6, PB7: AF1 */
  I2C1->TIMINGR = 0x10420F13;                      /* 100 kHz from the 8 MHz HSI */
  I2C1->CR1 = I2C_CR1_PE;
}
/* Returns 1 if every byte was acknowledged. */
static int i2c_write(uint8_t addr, const uint8_t *data, uint32_t n) {
  I2C1->CR2 = ((uint32_t)addr << 1) | (n << 16) | I2C_CR2_AUTOEND | I2C_CR2_START;
  while (n--) {
    while (!(I2C1->ISR & (I2C_ISR_TXIS | I2C_ISR_NACKF))) { }
    if (I2C1->ISR & I2C_ISR_NACKF) break;
    I2C1->TXDR = *data++;
  }
  while (!(I2C1->ISR & I2C_ISR_STOPF)) { }
  int nack = (I2C1->ISR & I2C_ISR_NACKF) != 0;
  I2C1->ICR = I2C_ICR_STOPCF | I2C_ICR_NACKCF;
  return !nack;
}
/* Write the register number, then read n bytes after a repeated START. */
static int i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buf, uint32_t n) {
  I2C1->CR2 = ((uint32_t)addr << 1) | (1u << 16) | I2C_CR2_START;
  while (!(I2C1->ISR & (I2C_ISR_TXIS | I2C_ISR_NACKF))) { }
  if (I2C1->ISR & I2C_ISR_NACKF) {
    while (!(I2C1->ISR & I2C_ISR_STOPF)) { }
    I2C1->ICR = I2C_ICR_STOPCF | I2C_ICR_NACKCF;
    return 0;
  }
  I2C1->TXDR = reg;
  while (!(I2C1->ISR & I2C_ISR_TC)) { }
  I2C1->CR2 = ((uint32_t)addr << 1) | I2C_CR2_RD_WRN | (n << 16) | I2C_CR2_AUTOEND | I2C_CR2_START;
  while (n--) {
    while (!(I2C1->ISR & I2C_ISR_RXNE)) { }
    *buf++ = (uint8_t)I2C1->RXDR;
  }
  while (!(I2C1->ISR & I2C_ISR_STOPF)) { }
  I2C1->ICR = I2C_ICR_STOPCF;
  return 1;
}
`;

describe('I2C1', () => {
  it('reads the temperature register of the sensor at 0x48 at about 100 kHz', async () => {
    const { mcu, board } = await boot(
      `${I2C()}
      volatile uint32_t raw, ok, done;
      int main(void) {
        uint8_t buf[2];
        i2c_init();
        ok = (uint32_t)i2c_read_reg(0x48, 0x00, buf, 2);
        raw = ((uint32_t)buf[0] << 8) | buf[1];
        done = 1;
        for (;;) { }
      }`,
      ['tmp102'],
    );
    board.device<Tmp102>('tmp102').input('tempC', 25.5);
    const scl = mcu.net('PB6');
    scl.startTrace();
    mcu.runSeconds(0.01);
    expect(mcu.readGlobal('done')).toBe(1);
    expect(mcu.readGlobal('ok')).toBe(1);
    expect(mcu.readGlobal('raw')).toBe(0x1980); // 25.5 / 0.0625 = 408, left-justified by 4
    const r = rises(scl);
    // address + register (2 x 9 clocks), then address + 2 data bytes (3 x 9 clocks), plus STOP / repeated START edges
    expect(r.length).toBeGreaterThanOrEqual(45);
    const period = r[5] - r[4];
    expect(period).toBeGreaterThan(8e-6);
    expect(period).toBeLessThan(11e-6);
    expect(mcu.net('PB6').level).toBe(1);
    expect(mcu.net('PB7').level).toBe(1);
    expect(mcu.hints).toEqual([]);
  });

  it('reports NACK when no device has the address', async () => {
    const { mcu } = await boot(
      `${I2C()}
      volatile uint32_t ok = 7, done;
      int main(void) {
        uint8_t buf[2];
        i2c_init();
        ok = (uint32_t)i2c_read_reg(0x49, 0x00, buf, 2);
        done = 1;
        for (;;) { }
      }`,
      ['tmp102'],
    );
    mcu.runSeconds(0.01);
    expect(mcu.readGlobal('done')).toBe(1);
    expect(mcu.readGlobal('ok')).toBe(0);
    expect(hintIds(mcu)).toContain('I2C1:nack:73');
  });

  it('writes to the EEPROM, waits out the write cycle and reads the data back', async () => {
    const { mcu, board } = await boot(
      `${I2C()}
      volatile uint32_t busy_nacks, match, done;
      int main(void) {
        static const uint8_t message[] = { 0x10, 'T', 'e', 's', 't' };   /* memory address, then data */
        uint8_t back[4];
        i2c_init();
        i2c_write(0x50, message, sizeof message);
        while (!i2c_read_reg(0x50, 0x10, back, 4)) { busy_nacks++; }      /* acknowledge polling */
        match = (back[0] == 'T' && back[1] == 'e' && back[2] == 's' && back[3] == 't');
        done = 1;
        for (;;) { }
      }`,
      ['eeprom'],
    );
    mcu.runSeconds(0.03);
    expect(mcu.readGlobal('done')).toBe(1);
    expect(mcu.readGlobal('match')).toBe(1);
    expect(mcu.readGlobal('busy_nacks')!).toBeGreaterThan(3);
    const rom = board.device<Eeprom>('eeprom');
    expect(String.fromCharCode(...rom.memory.subarray(0x10, 0x14))).toBe('Test');
    expect(rom.writes).toBe(1);
  });

  it('warns when the pins are push-pull instead of open-drain', async () => {
    const { mcu } = await boot(
      `${I2C('')}
      int main(void) { i2c_init(); for (;;) { } }`,
      ['tmp102'],
    );
    mcu.runSeconds(0.001);
    expect(hintIds(mcu)).toContain('i2c:od:PB6');
    expect(hintIds(mcu)).toContain('i2c:od:PB7');
  });
});

const SPI = (cr1 = 'SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1', cr2 = 'SPI_CR2_FRXTH | (7u << 8)') => `
#define SPI_DR8 (*(volatile uint8_t *)&SPI2->DR)
static void spi_init(void) {
  RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
  RCC->APB1ENR |= RCC_APB1ENR_SPI2EN;
  /* PB13 SCK, PB14 MISO, PB15 MOSI: AF0. PB11 and PB12: plain outputs (chip select, latch). */
  GPIOB->MODER |= GPIO_MODER_MODER13_1 | GPIO_MODER_MODER14_1 | GPIO_MODER_MODER15_1 | GPIO_MODER_MODER11_0 | GPIO_MODER_MODER12_0;
  GPIOB->BSRR = 1u << 11;                          /* chip select idles high */
  SPI2->CR2 = ${cr2};
  SPI2->CR1 = ${cr1};
  SPI2->CR1 |= SPI_CR1_SPE;
}
static uint8_t spi_transfer(uint8_t out) {
  while (!(SPI2->SR & SPI_SR_TXE)) { }
  SPI_DR8 = out;
  while (!(SPI2->SR & SPI_SR_RXNE)) { }
  return SPI_DR8;
}
`;

describe('SPI2', () => {
  it('shifts a byte into the LED bar and latches it, with 8 clock pulses at PCLK / 8', async () => {
    const { mcu, board } = await boot(
      `${SPI()}
      volatile uint32_t done;
      int main(void) {
        spi_init();
        spi_transfer(0xA5);
        GPIOB->BSRR = 1u << 12;                    /* latch: rising edge */
        GPIOB->BSRR = 1u << (12 + 16);
        done = 1;
        for (;;) { }
      }`,
      ['ledbar'],
    );
    const sck = mcu.net('PB13');
    sck.startTrace();
    mcu.runSeconds(0.002);
    expect(mcu.readGlobal('done')).toBe(1);
    const bar = board.device<LedBar>('ledbar');
    expect(bar.outputs).toBe(0xa5);
    expect(bar.latches).toBe(1);
    const r = rises(sck);
    expect(r.length).toBe(8);
    expect(r[1] - r[0]).toBeCloseTo(1e-6, 9);
    expect(mcu.hints).toEqual([]);
  });

  it('talks to the accelerometer: WHO_AM_I, enable, burst read of three axes', async () => {
    const { mcu, board } = await boot(
      `${SPI('SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1 | SPI_CR1_CPOL | SPI_CR1_CPHA')}
      volatile uint32_t who, done;
      volatile int32_t x_mg, y_mg, z_mg;
      static void cs(int low) { GPIOB->BSRR = low ? 1u << (11 + 16) : 1u << 11; }
      int main(void) {
        uint8_t b[6];
        spi_init();
        cs(1); spi_transfer(0x80 | 0x0F); who = spi_transfer(0); cs(0);
        cs(1); spi_transfer(0x20); spi_transfer(0x47); cs(0);            /* CTRL_REG1: 50 Hz, all axes */
        cs(1); spi_transfer(0xC0 | 0x28);
        for (int i = 0; i < 6; i++) b[i] = spi_transfer(0);
        cs(0);
        x_mg = (int16_t)(b[0] | (b[1] << 8)) >> 4;
        y_mg = (int16_t)(b[2] | (b[3] << 8)) >> 4;
        z_mg = (int16_t)(b[4] | (b[5] << 8)) >> 4;
        done = 1;
        for (;;) { }
      }`,
      ['accel'],
    );
    const acc = board.device<Accel>('accel');
    acc.input('tiltX', -30);
    acc.input('tiltY', 20);
    mcu.runSeconds(0.005);
    expect(mcu.readGlobal('done')).toBe(1);
    expect(mcu.readGlobal('who')).toBe(0x33);
    expect(mcu.readGlobal('x_mg')! | 0).toBe(-500);
    expect(mcu.readGlobal('y_mg')! | 0).toBe(342);
    expect(mcu.readGlobal('z_mg')! | 0).toBe(acc.mg()[2]);
    expect(acc.enabled()).toBe(true);
    expect(mcu.hints).toEqual([]);
  });

  it('explains a mode fault when SSI is missing', async () => {
    const { mcu } = await boot(
      `${SPI('SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_BR_1')}
      int main(void) { spi_init(); for (;;) { } }`,
      ['ledbar'],
    );
    mcu.runSeconds(0.001);
    expect(hintIds(mcu)).toContain('SPI2:modf');
  });

  it('explains why RXNE never sets without FRXTH, and the 16-bit data register trap', async () => {
    const noFrxth = await boot(
      `${SPI(undefined, '(7u << 8)')}
      int main(void) { spi_init(); spi_transfer(0x12); for (;;) { } }`,
      ['ledbar'],
    );
    noFrxth.mcu.runSeconds(0.002);
    expect(hintIds(noFrxth.mcu)).toContain('SPI2:frxth');

    const wide = await boot(
      `${SPI()}
      int main(void) { spi_init(); SPI2->DR = 0x12; for (;;) { } }`,
      ['ledbar'],
    );
    wide.mcu.runSeconds(0.002);
    expect(hintIds(wide.mcu)).toContain('SPI2:dr16');
  });
});
