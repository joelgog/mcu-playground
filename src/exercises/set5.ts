/** Exercises 17-19: I2C sensor, SPI shift register, SPI accelerometer. */
import { Accel, LedBar, Tmp102 } from '../board/busDevices';
import { fmt, near } from './runner';
import { Exercise } from './types';

const c = String.raw;

export const i2cSensor: Exercise = {
  id: 'i2c-sensor',
  refs: ['GPIO.OTYPER', 'I2C.TIMINGR', 'I2C.CR1', 'I2C.CR2', 'I2C.ISR', 'I2C.ICR', 'I2C.RXDR', 'I2C.TXDR'],
  sources: ['rm', 'i2c', 'tmp102'],
  title: 'I2C sensor',
  summary: 'Read a temperature register over I2C',
  brief:
    'Read the digital temperature sensor at I2C address `0x48` about ten times per second and store the result in tenths of a degree in `temperature_x10`.\n\n' +
    'The bus is on `PB6` (SCL) and `PB7` (SDA), alternate function 1. Register 0 of the sensor holds two bytes, high byte first: a signed 12-bit value in the upper bits, 0.0625 C per count.',
  background:
    'I2C needs only two wires because every device has an address and nobody ever drives a line high: devices pull the lines low, pull-up resistors bring them back. That is why both pins must be open-drain (`OTYPER`), a detail interviewers like to ask about.\n\n' +
    'Reading a register is two transfers glued together: a write of one byte (the register number), then, without releasing the bus, a repeated START and a read. On this STM32 family one transfer is described entirely in `CR2`: the 7-bit address shifted left by one in `SADD`, the direction in `RD_WRN`, the byte count in `NBYTES`, then `START`. ' +
    'The hardware raises `TXIS` when it wants a byte in `TXDR` and `RXNE` when a byte is waiting in `RXDR`. With `AUTOEND` it sends the STOP by itself after the last byte; without it, it stops at `TC` so you can issue the repeated START.\n\n' +
    'Always handle the NACK case (`NACKF`): a wrong address or an unplugged sensor must not hang the firmware in a wait loop.\n\n' +
    'The conversion is a typical datasheet exercise: combine the bytes, cast to `int16_t` so the sign survives, shift right by 4 to drop the unused bits, then scale. 0.0625 is 1/16, so tenths of a degree = counts x 10 / 16.',
  devices: ['tmp102'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

#define SENSOR_ADDR 0x48u

/* Temperature in tenths of a degree Celsius. Keep this name: the checker reads it. */
volatile int32_t temperature_x10;

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

static void i2c_init(void)
{
    /* TODO: clocks for GPIOB and I2C1.
     *       PB6 and PB7: alternate function 1, open-drain.
     *       I2C1->TIMINGR = 0x10420F13 gives 100 kHz from the 8 MHz HSI. Then enable with PE. */
}

/* TODO: write 'reg' to the device, then read 'count' bytes after a repeated START.
 *       Return 1 on success, 0 if the device did not acknowledge. */
static int i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buffer, uint32_t count)
{
    (void)addr;
    (void)reg;
    (void)buffer;
    (void)count;
    return 0;
}

int main(void)
{
    SysTick_Config(SystemCoreClock / 1000u);
    i2c_init();

    uint32_t last = 0;

    for (;;) {
        if (ms_ticks - last >= 100u) {
            last += 100u;

            uint8_t data[2];
            if (i2c_read_reg(SENSOR_ADDR, 0x00, data, 2)) {
                /* TODO: convert the two bytes to tenths of a degree. */
            }
        }
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

#define SENSOR_ADDR 0x48u

volatile int32_t temperature_x10;

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

static void i2c_init(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
    RCC->APB1ENR |= RCC_APB1ENR_I2C1EN;

    /* PB6 = SCL, PB7 = SDA: alternate function 1, open-drain (the board has the pull-ups) */
    GPIOB->MODER = (GPIOB->MODER & ~(GPIO_MODER_MODER6 | GPIO_MODER_MODER7)) | GPIO_MODER_MODER6_1 | GPIO_MODER_MODER7_1;
    GPIOB->OTYPER |= GPIO_OTYPER_OT_6 | GPIO_OTYPER_OT_7;
    GPIOB->AFR[0] = (GPIOB->AFR[0] & ~0xFF000000u) | 0x11000000u;

    I2C1->TIMINGR = 0x10420F13;             /* 100 kHz from the 8 MHz HSI */
    I2C1->CR1 = I2C_CR1_PE;
}

static int i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buffer, uint32_t count)
{
    /* Transfer 1: write one byte (the register number). No AUTOEND, so the bus is kept at TC. */
    I2C1->CR2 = ((uint32_t)addr << 1) | (1u << I2C_CR2_NBYTES_Pos) | I2C_CR2_START;

    while (!(I2C1->ISR & (I2C_ISR_TXIS | I2C_ISR_NACKF))) {
    }
    if (I2C1->ISR & I2C_ISR_NACKF) {        /* nobody answered: the hardware sends the STOP */
        while (!(I2C1->ISR & I2C_ISR_STOPF)) {
        }
        I2C1->ICR = I2C_ICR_NACKCF | I2C_ICR_STOPCF;
        return 0;
    }
    I2C1->TXDR = reg;
    while (!(I2C1->ISR & I2C_ISR_TC)) {
    }

    /* Transfer 2: repeated START, read 'count' bytes, STOP automatically after the last one. */
    I2C1->CR2 = ((uint32_t)addr << 1) | I2C_CR2_RD_WRN | (count << I2C_CR2_NBYTES_Pos) | I2C_CR2_AUTOEND | I2C_CR2_START;

    for (uint32_t i = 0; i < count; i++) {
        while (!(I2C1->ISR & I2C_ISR_RXNE)) {
        }
        buffer[i] = (uint8_t)I2C1->RXDR;
    }
    while (!(I2C1->ISR & I2C_ISR_STOPF)) {
    }
    I2C1->ICR = I2C_ICR_STOPCF;
    return 1;
}

int main(void)
{
    SysTick_Config(SystemCoreClock / 1000u);
    i2c_init();

    uint32_t last = 0;

    for (;;) {
        if (ms_ticks - last >= 100u) {
            last += 100u;

            uint8_t data[2];
            if (i2c_read_reg(SENSOR_ADDR, 0x00, data, 2)) {
                int16_t raw = (int16_t)(((uint16_t)data[0] << 8) | data[1]);
                int32_t counts = raw >> 4;              /* 12-bit value, 1/16 degree per count */
                temperature_x10 = (counts * 10) / 16;
            }
        }
    }
}
`,
  },
  check(ctx) {
    const sensor = ctx.board.device<Tmp102>('tmp102');
    const cases: Array<[number, number]> = [[23.5, 235], [0, 0], [85, 850], [-10.25, -102]];
    for (const [temp, want] of cases) {
      sensor.input('tempC', temp);
      const before = sensor.reads;
      ctx.run(0.35);
      const got = ctx.global('temperature_x10');
      ctx.expect(
        `${temp} C reads as ${want}`,
        got !== null && near(got | 0, want, 1) && sensor.reads > before,
        sensor.reads === before ? 'the sensor was not read' : got === null ? 'variable temperature_x10 not found' : `temperature_x10 = ${got | 0}`,
      );
    }
    const rate = sensor.reads / 1.4;
    ctx.expect('Reads about 10 times per second', rate >= 5 && rate <= 20, `${fmt(rate, 3)} reads per second`);
    const hz = ctx.mcu.i2c1.sclHz();
    ctx.expect('Bus speed is between 50 and 400 kHz', hz >= 50_000 && hz <= 420_000, hz > 0 ? `SCL at ${fmt(hz / 1000, 3)} kHz` : 'TIMINGR is not set');
    ctx.expect(
      'SCL and SDA are open-drain',
      !ctx.hinted('i2c:od'),
      ctx.hinted('i2c:od') ? 'the pins are push-pull: set their OTYPER bits' : 'OTYPER bits set',
    );
  },
};

export const spiLeds: Exercise = {
  id: 'spi-shift-register',
  refs: ['GPIO.AFR', 'SPI.CR1', 'SPI.CR2', 'SPI.SR', 'SPI.DR'],
  sources: ['rm', 'hc595'],
  title: 'SPI shift register',
  summary: 'Drive eight LEDs through a 74HC595',
  brief:
    'Make a running light on the LED bar: exactly one LED lit, moving one position every 100 ms from Q0 up to Q7 and then starting again at Q0.\n\n' +
    'The LEDs hang on a 74HC595 shift register: send one byte over SPI2 (`PB13` clock, `PB15` data, alternate function 0), then pulse the latch pin `PB12` high to show it. The first bit sent ends up on Q7.',
  background:
    'SPI is a shift register on each side, clocked by the master. For every bit the master puts out on MOSI, one comes back on MISO: there is no "write only", so after each byte you have received one too, even if it is meaningless.\n\n' +
    'Setting up an STM32 as SPI master has three classic traps, all of which this simulator reproduces. ' +
    'First, with software slave management (`SSM`) you must also set `SSI`, otherwise the peripheral believes another master has taken the bus, raises a mode fault and silently drops out of master mode. ' +
    'Second, on the F0 the data register is 16 bits wide in the header but the frame is 8 bits: write it through a byte pointer, `*(volatile uint8_t *)&SPI2->DR = value`, or two bytes are sent. ' +
    'Third, `RXNE` only reports a single byte if `FRXTH` is set in `CR2`.\n\n' +
    'Clock polarity and phase (CPOL / CPHA, "mode 0 to 3") decide which clock edge samples the data. The 74HC595 samples on the rising edge, which is mode 0 or mode 3.\n\n' +
    'The 595 keeps what was shifted in hidden until the latch pin rises, so the outputs change all at once instead of rippling. Shifting first and latching afterwards is the same idea as a double buffer.',
  devices: ['ledbar'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

static void spi_init(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOBEN;

    /* PB12 = latch: plain output, idle low */
    GPIOB->MODER = (GPIOB->MODER & ~GPIO_MODER_MODER12) | GPIO_MODER_MODER12_0;

    /* TODO: SPI2 clock. PB13 and PB15 to alternate function 0.
     *       CR2: 8-bit frames (DS = 0111) and FRXTH.
     *       CR1: master, software slave management (SSM and SSI), a baud rate divider, then SPE. */
}

/* TODO: send one byte and wait until it has been shifted out completely. */
static void spi_send(uint8_t value)
{
    (void)value;
}

static void show(uint8_t pattern)
{
    spi_send(pattern);
    /* TODO: pulse the latch pin PB12 high, then low. */
}

int main(void)
{
    SysTick_Config(SystemCoreClock / 1000u);
    spi_init();

    uint32_t last = 0;

    show(0x01);

    for (;;) {
        if (ms_ticks - last >= 100u) {
            last += 100u;
            /* TODO: advance the running light and call show(). */
        }
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

/* The data register is 16 bits wide in the header; an 8-bit frame needs an 8-bit access. */
#define SPI2_DR8 (*(volatile uint8_t *)&SPI2->DR)

static volatile uint32_t ms_ticks;

void SysTick_Handler(void)
{
    ms_ticks++;
}

static void spi_init(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
    RCC->APB1ENR |= RCC_APB1ENR_SPI2EN;

    /* PB12 = latch (output), PB13 = SCK and PB15 = MOSI (alternate function 0, the reset value of AFR) */
    GPIOB->MODER = (GPIOB->MODER & ~(GPIO_MODER_MODER12 | GPIO_MODER_MODER13 | GPIO_MODER_MODER15))
                 | GPIO_MODER_MODER12_0 | GPIO_MODER_MODER13_1 | GPIO_MODER_MODER15_1;
    GPIOB->AFR[1] &= ~((0xFu << ((13 - 8) * 4)) | (0xFu << ((15 - 8) * 4)));

    SPI2->CR2 = (7u << SPI_CR2_DS_Pos) | SPI_CR2_FRXTH;                 /* 8-bit frames, RXNE per byte */
    SPI2->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1; /* master, mode 0, 8 MHz / 8 */
    SPI2->CR1 |= SPI_CR1_SPE;
}

static void spi_send(uint8_t value)
{
    while (!(SPI2->SR & SPI_SR_TXE)) {
    }
    SPI2_DR8 = value;
    while (!(SPI2->SR & SPI_SR_RXNE)) {     /* a byte always comes back: wait for it ... */
    }
    (void)SPI2_DR8;                         /* ... and read it so the receive FIFO stays empty */
}

static void show(uint8_t pattern)
{
    spi_send(pattern);
    GPIOB->BSRR = 1u << 12;                 /* rising edge copies the shift register to the outputs */
    GPIOB->BSRR = 1u << (12 + 16);
}

int main(void)
{
    SysTick_Config(SystemCoreClock / 1000u);
    spi_init();

    uint32_t last = 0;
    uint8_t position = 0;

    show(1u << position);

    for (;;) {
        if (ms_ticks - last >= 100u) {
            last += 100u;
            position = (uint8_t)((position + 1u) & 7u);
            show((uint8_t)(1u << position));
        }
    }
}
`,
  },
  check(ctx) {
    const bar = ctx.board.device<LedBar>('ledbar');
    ctx.run(1.85);
    const h = bar.history;
    ctx.expect('The LED bar is updated', h.length >= 10, h.length ? `${h.length} patterns latched in 1.85 s` : 'nothing was latched: no byte arrived, or PB12 never pulsed');
    const oneHot = h.every((v) => v !== 0 && (v & (v - 1)) === 0);
    const bad = h.find((v) => v === 0 || (v & (v - 1)) !== 0);
    ctx.expect(
      'Exactly one LED is lit at any time',
      h.length > 0 && oneHot,
      h.length === 0 ? 'nothing shown' : oneHot ? 'always a single bit' : `showed 0b${(bad ?? 0).toString(2).padStart(8, '0')}`,
    );
    let moves = h.length > 1;
    let detail = 'Q0, Q1, ... Q7, Q0, ...';
    for (let i = 1; i < h.length && moves; i++) {
      const expected = h[i - 1] === 0x80 ? 0x01 : (h[i - 1] << 1) & 0xff;
      if (h[i] !== expected) {
        moves = false;
        detail = `after 0b${h[i - 1].toString(2).padStart(8, '0')} came 0b${h[i].toString(2).padStart(8, '0')}`;
      }
    }
    ctx.expect('The light moves from Q0 towards Q7 and wraps around', moves && h.includes(0x80) && h.includes(0x01), moves ? detail : detail);
    const t = bar.historyT;
    let steady = t.length > 3;
    let worst = 0;
    for (let i = 2; i < t.length; i++) {
      const dt = t[i] - t[i - 1];
      worst = Math.max(worst, Math.abs(dt - 0.1));
      if (!near(dt, 0.1, 0.01)) steady = false;
    }
    ctx.expect('One step every 100 ms', steady, t.length > 3 ? `largest deviation ${fmt(worst * 1000, 2)} ms` : 'not enough steps to measure');
    const trap = ctx.hinted('SPI2:modf') ? 'mode fault: SSI is missing' : ctx.hinted('SPI2:dr16') ? 'DR written with a 16-bit access' : ctx.hinted('ledbar:mode') ? 'wrong SPI mode for the 74HC595' : ctx.hinted('SPI2:ovr') ? 'receive FIFO overran: DR is never read' : null;
    ctx.expect('SPI is set up without the classic traps', trap === null, trap ?? 'master mode, 8-bit access, mode 0 or 3');
  },
};

export const spiAccel: Exercise = {
  id: 'spi-accelerometer',
  refs: ['SPI.CR1', 'SPI.CR2', 'SPI.SR', 'SPI.DR', 'GPIO.BSRR'],
  sources: ['rm', 'lis3dh'],
  title: 'SPI accelerometer',
  summary: 'Identify a sensor and burst-read its registers',
  brief:
    'Talk to the accelerometer on SPI2 (`PB13` clock, `PB14` MISO, `PB15` MOSI, chip select `PB11`, active low). Read its WHO_AM_I register `0x0F` into `who_am_i` (it should be `0x33`), switch it on by writing `0x47` to CTRL_REG1 `0x20`, then keep reading the three axes into `accel_x_mg`, `accel_y_mg` and `accel_z_mg`.\n\n' +
    'First byte of a transfer: bit 7 set = read, bit 6 set = auto-increment the register address. The axis data is six bytes starting at `0x28`: X low, X high, Y low, Y high, Z low, Z high. Each axis is a signed 16-bit value; shifted right by 4 it is the acceleration in mg.',
  background:
    'This is the shape of almost every SPI sensor driver, and of many interview take-home tasks.\n\n' +
    'Chip select frames a transaction: pull it low, clock the command byte, clock the data bytes, release it. The sensor resets its command state when CS goes high, so never leave it low between transfers. To read you still have to send something: dummy bytes whose only purpose is to produce clock pulses.\n\n' +
    'Read the identity register first. If WHO_AM_I is wrong, the wiring, the mode or the chip select is wrong, and nothing else will work. This sensor needs mode 0 or 3 and is powered down after reset: until a data rate is written to CTRL_REG1 all outputs read zero, which is the most common "my sensor returns 0" cause.\n\n' +
    'Read all six bytes in one burst (auto-increment), so the three axes belong to the same sample. Then mind the byte order and the sign: this sensor is little-endian (low byte first, the opposite of the I2C temperature sensor), and the cast to `int16_t` must happen before the shift, so that the shift is arithmetic and negative values stay negative.',
  devices: ['accel'],
  starter: {
    'main.c': c`#include "stm32f0xx.h"

#define SPI2_DR8 (*(volatile uint8_t *)&SPI2->DR)

#define REG_WHO_AM_I  0x0Fu
#define REG_CTRL_REG1 0x20u
#define REG_OUT_X_L   0x28u
#define CMD_READ      0x80u
#define CMD_AUTO_INC  0x40u

/* Results. Keep these names: the checker reads them. */
volatile uint32_t who_am_i;
volatile int32_t accel_x_mg;
volatile int32_t accel_y_mg;
volatile int32_t accel_z_mg;

static void spi_init(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
    RCC->APB1ENR |= RCC_APB1ENR_SPI2EN;

    /* PB11 = chip select (output, idle high); PB13, PB14, PB15 = SPI2 on alternate function 0 */
    GPIOB->BSRR = 1u << 11;
    GPIOB->MODER = (GPIOB->MODER & ~(GPIO_MODER_MODER11 | GPIO_MODER_MODER13 | GPIO_MODER_MODER14 | GPIO_MODER_MODER15))
                 | GPIO_MODER_MODER11_0 | GPIO_MODER_MODER13_1 | GPIO_MODER_MODER14_1 | GPIO_MODER_MODER15_1;

    SPI2->CR2 = (7u << SPI_CR2_DS_Pos) | SPI_CR2_FRXTH;
    SPI2->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1 | SPI_CR1_CPOL | SPI_CR1_CPHA;   /* mode 3 */
    SPI2->CR1 |= SPI_CR1_SPE;
}

/* Provided: clock one byte out and return the byte that came back. */
static uint8_t spi_transfer(uint8_t out)
{
    while (!(SPI2->SR & SPI_SR_TXE)) {
    }
    SPI2_DR8 = out;
    while (!(SPI2->SR & SPI_SR_RXNE)) {
    }
    return SPI2_DR8;
}

int main(void)
{
    spi_init();
    (void)spi_transfer;                     /* silences "unused function" until you call it */

    /* TODO 1: read WHO_AM_I into who_am_i (chip select low, command byte, dummy byte, chip select high). */
    /* TODO 2: write 0x47 to CTRL_REG1 to switch the sensor on. */

    for (;;) {
        /* TODO 3: burst-read six bytes from OUT_X_L and convert them to mg. */
    }
}
`,
  },
  solution: {
    'main.c': c`#include "stm32f0xx.h"

#define SPI2_DR8 (*(volatile uint8_t *)&SPI2->DR)

#define REG_WHO_AM_I  0x0Fu
#define REG_CTRL_REG1 0x20u
#define REG_OUT_X_L   0x28u
#define CMD_READ      0x80u
#define CMD_AUTO_INC  0x40u

volatile uint32_t who_am_i;
volatile int32_t accel_x_mg;
volatile int32_t accel_y_mg;
volatile int32_t accel_z_mg;

static void spi_init(void)
{
    RCC->AHBENR |= RCC_AHBENR_GPIOBEN;
    RCC->APB1ENR |= RCC_APB1ENR_SPI2EN;

    GPIOB->BSRR = 1u << 11;
    GPIOB->MODER = (GPIOB->MODER & ~(GPIO_MODER_MODER11 | GPIO_MODER_MODER13 | GPIO_MODER_MODER14 | GPIO_MODER_MODER15))
                 | GPIO_MODER_MODER11_0 | GPIO_MODER_MODER13_1 | GPIO_MODER_MODER14_1 | GPIO_MODER_MODER15_1;

    SPI2->CR2 = (7u << SPI_CR2_DS_Pos) | SPI_CR2_FRXTH;
    SPI2->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1 | SPI_CR1_CPOL | SPI_CR1_CPHA;
    SPI2->CR1 |= SPI_CR1_SPE;
}

static uint8_t spi_transfer(uint8_t out)
{
    while (!(SPI2->SR & SPI_SR_TXE)) {
    }
    SPI2_DR8 = out;
    while (!(SPI2->SR & SPI_SR_RXNE)) {
    }
    return SPI2_DR8;
}

static void cs_low(void)  { GPIOB->BSRR = 1u << (11 + 16); }
static void cs_high(void) { GPIOB->BSRR = 1u << 11; }

static uint8_t sensor_read(uint8_t reg)
{
    cs_low();
    spi_transfer((uint8_t)(CMD_READ | reg));
    uint8_t value = spi_transfer(0x00);     /* dummy byte: only there to make clock pulses */
    cs_high();
    return value;
}

static void sensor_write(uint8_t reg, uint8_t value)
{
    cs_low();
    spi_transfer(reg);
    spi_transfer(value);
    cs_high();
}

static void sensor_read_burst(uint8_t reg, uint8_t *buffer, uint32_t count)
{
    cs_low();
    spi_transfer((uint8_t)(CMD_READ | CMD_AUTO_INC | reg));
    for (uint32_t i = 0; i < count; i++) {
        buffer[i] = spi_transfer(0x00);
    }
    cs_high();
}

/* Little-endian, signed, left-justified 12 bits: cast first so the shift keeps the sign. */
static int32_t to_mg(uint8_t low, uint8_t high)
{
    int16_t raw = (int16_t)(((uint16_t)high << 8) | low);
    return raw >> 4;
}

int main(void)
{
    spi_init();

    who_am_i = sensor_read(REG_WHO_AM_I);
    sensor_write(REG_CTRL_REG1, 0x47);      /* 50 Hz, X, Y and Z enabled */

    for (;;) {
        uint8_t data[6];

        sensor_read_burst(REG_OUT_X_L, data, 6);
        accel_x_mg = to_mg(data[0], data[1]);
        accel_y_mg = to_mg(data[2], data[3]);
        accel_z_mg = to_mg(data[4], data[5]);
    }
}
`,
  },
  check(ctx) {
    const acc = ctx.board.device<Accel>('accel');
    ctx.run(0.02);
    const who = ctx.global('who_am_i');
    ctx.expect('WHO_AM_I reads 0x33', who === 0x33, who === null ? 'variable who_am_i not found' : `who_am_i = 0x${who.toString(16).toUpperCase().padStart(2, '0')}`);
    ctx.expect('The sensor is switched on (CTRL_REG1)', acc.enabled(), acc.enabled() ? 'data rate selected' : 'still powered down: the outputs read 0');
    const read = () => [ctx.global('accel_x_mg'), ctx.global('accel_y_mg'), ctx.global('accel_z_mg')].map((v) => (v === null ? NaN : v | 0));
    const cases: Array<[string, number, number]> = [['Lying flat', 0, 0], ['Tilted 30 degrees around X', 30, 0], ['Tilted -45 degrees around Y', 0, -45], ['Tilted both ways', -60, 20]];
    for (const [label, tx, ty] of cases) {
      acc.input('tiltX', tx);
      acc.input('tiltY', ty);
      const before = acc.outputReads;
      ctx.run(0.02);
      const want = acc.mg();
      const got = read();
      const ok = got.every((v, i) => near(v, want[i], 2)) && acc.outputReads > before;
      ctx.expect(
        `${label}: X ${want[0]}, Y ${want[1]}, Z ${want[2]} mg`,
        ok,
        acc.outputReads === before ? 'the output registers were not read' : `read X ${got[0]}, Y ${got[1]}, Z ${got[2]} mg`,
      );
    }
    ctx.expect(
      'Chip select is released between transfers',
      ctx.mcu.net('PB11').level === 1 || acc.outputReads > 10,
      acc.outputReads > 10 ? `${acc.outputReads} separate burst reads` : 'chip select stays low',
    );
  },
};
