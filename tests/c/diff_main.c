/*
 * Differential test program: compiled natively (host gcc) and for the emulated
 * Cortex-M0. Both must print exactly the same text.
 * Only fixed-width types and deterministic, well-defined C are used.
 */
#include <setjmp.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void put_str(const char *s) { while (*s) putchar(*s++); }
static void put_hex32(uint32_t v)
{
    static const char digits[] = "0123456789abcdef";
    for (int i = 28; i >= 0; i -= 4) putchar(digits[(v >> i) & 15u]);
}
static void put_hex64(uint64_t v) { put_hex32((uint32_t)(v >> 32)); put_hex32((uint32_t)v); }
static void put_dec(int32_t v)
{
    char b[12];
    int n = 0;
    uint32_t u = v < 0 ? 0u - (uint32_t)v : (uint32_t)v;
    if (v < 0) putchar('-');
    do { b[n++] = (char)('0' + u % 10u); u /= 10u; } while (u);
    while (n) putchar(b[--n]);
}
static void line32(const char *name, uint32_t v) { put_str(name); putchar('='); put_hex32(v); putchar('\n'); }
static void line64(const char *name, uint64_t v) { put_str(name); putchar('='); put_hex64(v); putchar('\n'); }

static uint32_t rng_state = 0x12345678u;
static uint32_t rng(void)
{
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state;
}
static uint32_t mix(uint32_t h, uint32_t v) { h ^= v; h *= 16777619u; return (h << 7) | (h >> 25); }

/* ---------------------------------------------------------------- crc32 */
static uint32_t crc_table[256];
static uint32_t crc32_bitwise(const uint8_t *p, uint32_t n)
{
    uint32_t c = 0xffffffffu;
    while (n--) {
        c ^= *p++;
        for (int k = 0; k < 8; k++) c = (c & 1u) ? (c >> 1) ^ 0xedb88320u : c >> 1;
    }
    return ~c;
}
static uint32_t crc32_table(const uint8_t *p, uint32_t n)
{
    uint32_t c = 0xffffffffu;
    while (n--) c = crc_table[(c ^ *p++) & 0xffu] ^ (c >> 8);
    return ~c;
}
static void test_crc(void)
{
    static uint8_t buf[300];
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = (c & 1u) ? (c >> 1) ^ 0xedb88320u : c >> 1;
        crc_table[i] = c;
    }
    for (uint32_t i = 0; i < sizeof buf; i++) buf[i] = (uint8_t)rng();
    line32("crc_bitwise", crc32_bitwise(buf, sizeof buf));
    line32("crc_table", crc32_table(buf, sizeof buf));
    line32("crc_123456789", crc32_bitwise((const uint8_t *)"123456789", 9));
}

/* ------------------------------------------------------ 32-bit integers */
static void test_int32(void)
{
    uint32_t h = 2166136261u;
    for (int i = 0; i < 400; i++) {
        uint32_t a = rng(), b = rng();
        if (i % 7 == 0) a = 0x80000000u;
        if (i % 11 == 0) b = 0xffffffffu;
        if (i % 13 == 0) b = 1u;
        if (i % 17 == 0) a >>= (b & 31u);
        int32_t sa = (int32_t)a, sb = (int32_t)b;
        uint32_t sh = b & 31u;
        h = mix(h, a + b);
        h = mix(h, a - b);
        h = mix(h, a * b);
        if (b != 0) { h = mix(h, a / b); h = mix(h, a % b); }
        if (sb != 0 && !(sa == INT32_MIN && sb == -1)) {
            h = mix(h, (uint32_t)(sa / sb));
            h = mix(h, (uint32_t)(sa % sb));
        }
        h = mix(h, a << sh);
        h = mix(h, a >> sh);
        h = mix(h, (uint32_t)(sa >> sh));
        h = mix(h, (a >> sh) | (a << ((32u - sh) & 31u)));
        h = mix(h, (uint32_t)(a < b) | ((uint32_t)(sa < sb) << 1) | ((uint32_t)(a >= b) << 2) |
                   ((uint32_t)(sa >= sb) << 3) | ((uint32_t)(a == b) << 4) | ((uint32_t)(sa > sb) << 5) |
                   ((uint32_t)(a > b) << 6) | ((uint32_t)(sa <= sb) << 7));
        h = mix(h, a & b);
        h = mix(h, a | b);
        h = mix(h, a ^ b);
        h = mix(h, ~a);
        h = mix(h, a & ~b);
        h = mix(h, 0u - a);
        h = mix(h, (uint32_t)__builtin_popcount(a));
        if (a != 0) { h = mix(h, (uint32_t)__builtin_clz(a)); h = mix(h, (uint32_t)__builtin_ctz(a)); }
        h = mix(h, __builtin_bswap32(a));
        h = mix(h, a / 10u);
        h = mix(h, a % 1000u);
        h = mix(h, (uint32_t)(sa / 7));
        h = mix(h, (uint32_t)(int32_t)(int8_t)a);
        h = mix(h, (uint32_t)(int32_t)(int16_t)a);
        h = mix(h, (uint32_t)(uint8_t)a + (uint32_t)(uint16_t)b);
    }
    line32("int32", h);
}

/* ------------------------------------------------------ 64-bit integers */
static void test_int64(void)
{
    uint64_t h = 1469598103934665603ull;
    for (int i = 0; i < 200; i++) {
        uint64_t a = ((uint64_t)rng() << 32) | rng();
        uint64_t b = ((uint64_t)rng() << 32) | rng();
        if (i % 5 == 0) b >>= 40;
        if (i % 9 == 0) a >>= 33;
        int64_t sa = (int64_t)a, sb = (int64_t)b;
        uint32_t sh = (uint32_t)b & 63u;
        h = (h ^ (a + b)) * 1099511628211ull;
        h = (h ^ (a - b)) * 1099511628211ull;
        h = (h ^ (a * b)) * 1099511628211ull;
        if (b != 0) { h = (h ^ (a / b)) * 1099511628211ull; h = (h ^ (a % b)) * 1099511628211ull; }
        if (sb != 0 && !(sa == INT64_MIN && sb == -1)) {
            h = (h ^ (uint64_t)(sa / sb)) * 1099511628211ull;
            h = (h ^ (uint64_t)(sa % sb)) * 1099511628211ull;
        }
        h = (h ^ (a << sh)) * 1099511628211ull;
        h = (h ^ (a >> sh)) * 1099511628211ull;
        h = (h ^ (uint64_t)(sa >> sh)) * 1099511628211ull;
        h = (h ^ (uint64_t)(a < b)) * 1099511628211ull;
        h = (h ^ (uint64_t)(sa < sb)) * 1099511628211ull;
    }
    line64("int64", h);
}

/* -------------------------------------------------------------- sorting */
static int cmp_int32(const void *a, const void *b)
{
    int32_t x = *(const int32_t *)a, y = *(const int32_t *)b;
    return (x > y) - (x < y);
}
static void test_sort(void)
{
    static int32_t v[96];
    static int16_t w[64];
    for (int i = 0; i < 96; i++) v[i] = (int32_t)rng();
    qsort(v, 96, sizeof v[0], cmp_int32);
    uint32_t h = 0;
    int sorted = 1;
    for (int i = 0; i < 96; i++) {
        h = mix(h, (uint32_t)v[i]);
        if (i && v[i - 1] > v[i]) sorted = 0;
    }
    line32("qsort", h);
    line32("qsort_sorted", (uint32_t)sorted);
    for (int i = 0; i < 64; i++) w[i] = (int16_t)rng();
    for (int i = 1; i < 64; i++) {
        int16_t key = w[i];
        int j = i - 1;
        while (j >= 0 && w[j] > key) { w[j + 1] = w[j]; j--; }
        w[j + 1] = key;
    }
    h = 0;
    for (int i = 0; i < 64; i++) h = mix(h, (uint32_t)(int32_t)w[i]);
    line32("insertion_sort", h);
}

/* ------------------------------------------------------------ recursion */
static uint32_t fib(uint32_t n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
static uint32_t ack(uint32_t m, uint32_t n)
{
    if (m == 0) return n + 1;
    if (n == 0) return ack(m - 1, 1);
    return ack(m - 1, ack(m, n - 1));
}
static uint32_t hanoi(int n, int from, int to, int via)
{
    if (n == 0) return 0;
    return hanoi(n - 1, from, via, to) + 1 + hanoi(n - 1, via, to, from) + (uint32_t)(from * 3 + to);
}
static void test_recursion(void)
{
    line32("fib20", fib(20));
    line32("ack23", ack(2, 3));
    line32("hanoi9", hanoi(9, 1, 3, 2));
}

/* -------------------------------------------------------------- strings */
static void test_memory(void)
{
    static uint8_t src[160], dst[200];
    uint32_t h = 0;
    for (uint32_t i = 0; i < sizeof src; i++) src[i] = (uint8_t)(rng() | 1u);
    for (uint32_t off_s = 0; off_s < 4; off_s++) {
        for (uint32_t off_d = 0; off_d < 4; off_d++) {
            for (uint32_t len = 0; len < 70; len += 7) {
                memset(dst, 0xa5, sizeof dst);
                memcpy(dst + off_d, src + off_s, len);
                for (uint32_t i = 0; i < 90; i++) h = mix(h, dst[i]);
            }
        }
    }
    line32("memcpy", h);
    memcpy(dst, src, 100);
    memmove(dst + 5, dst, 80);
    memmove(dst + 20, dst + 31, 60);
    h = 0;
    for (uint32_t i = 0; i < 120; i++) h = mix(h, dst[i]);
    line32("memmove", h);
    char s1[40], s2[40];
    strcpy(s1, "embedded systems");
    strcpy(s2, "embedded sensors");
    line32("strlen", (uint32_t)strlen(s1));
    line32("strcmp", (uint32_t)(strcmp(s1, s2) > 0) | ((uint32_t)(strcmp(s2, s1) < 0) << 1) | ((uint32_t)(strcmp(s1, s1) == 0) << 2));
    line32("strncmp", (uint32_t)(strncmp(s1, s2, 10) == 0));
    line32("memcmp", (uint32_t)(memcmp(s1, s2, 16) != 0));
    strcat(s1, "!");
    line32("strchr", (uint32_t)(strchr(s1, '!') - s1));
}

/* -------------------------------------------------------------- structs */
typedef struct { uint8_t a; uint32_t b; int16_t c; uint64_t d; uint8_t e[5]; } mixed_t;
typedef struct { uint32_t lo : 5; uint32_t mid : 11; uint32_t hi : 16; } fields_t;
typedef union { uint32_t u; uint8_t b[4]; uint16_t h[2]; } pun_t;

static mixed_t transform(mixed_t m, int k)
{
    m.a = (uint8_t)(m.a + k);
    m.b ^= 0xdeadbeefu;
    m.c = (int16_t)(m.c - k);
    m.d = m.d * 3u + (uint64_t)k;
    for (int i = 0; i < 5; i++) m.e[i] = (uint8_t)(m.e[i] ^ (uint8_t)(i * k));
    return m;
}
static void test_structs(void)
{
    mixed_t m = {7, 0x11223344u, -1234, 0x0102030405060708ull, {1, 2, 3, 4, 5}};
    for (int k = 1; k < 9; k++) m = transform(m, k);
    uint32_t h = mix(mix(mix(0, m.a), m.b), (uint32_t)(int32_t)m.c);
    h = mix(mix(h, (uint32_t)m.d), (uint32_t)(m.d >> 32));
    for (int i = 0; i < 5; i++) h = mix(h, m.e[i]);
    line32("struct", h);
    line32("sizeof_mixed", (uint32_t)sizeof(mixed_t));
    fields_t f = {0, 0, 0};
    f.lo = 21u; f.mid = 1500u; f.hi = 0xabcdu;
    f.mid += 700u;
    uint32_t raw;
    memcpy(&raw, &f, sizeof raw);
    line32("bitfield", raw);
    pun_t p;
    p.u = 0x11223344u;
    line32("endian", ((uint32_t)p.b[0] << 8) | p.b[3] | ((uint32_t)p.h[1] << 16));
}

/* --------------------------------------------------------------- switch */
static uint32_t dense(uint32_t x)
{
    switch (x) {
    case 0: return 11; case 1: return 23; case 2: return 5; case 3: return 99;
    case 4: return 42; case 5: return 7; case 6: return 1000; case 7: return 3;
    case 8: return 77; case 9: return 64; case 10: return 8; case 11: return 15;
    default: return x * 2u;
    }
}
static uint32_t sparse(uint32_t x)
{
    switch (x) {
    case 3: return 1; case 100: return 2; case 5000: return 3; case 70000: return 4;
    case 0x80000000u: return 5;
    default: return 6;
    }
}
static uint32_t apply_add(uint32_t a, uint32_t b) { return a + b; }
static uint32_t apply_xor(uint32_t a, uint32_t b) { return a ^ b; }
static uint32_t apply_mul(uint32_t a, uint32_t b) { return a * b + 1u; }
static void test_control(void)
{
    uint32_t h = 0;
    for (uint32_t i = 0; i < 16; i++) h = mix(h, dense(i));
    static const uint32_t probes[] = {3, 100, 5000, 70000, 0x80000000u, 4, 0};
    for (uint32_t i = 0; i < 7; i++) h = mix(h, sparse(probes[i]));
    uint32_t (*const ops[3])(uint32_t, uint32_t) = {apply_add, apply_xor, apply_mul};
    for (uint32_t i = 0; i < 30; i++) h = ops[i % 3u](h, i + 0x9e3779b9u);
    line32("control", h);
}

/* ---------------------------------------------------------------- float */
static uint32_t fbits(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }
static uint64_t dbits(double d) { uint64_t u; memcpy(&u, &d, 8); return u; }
static void test_float(void)
{
    volatile float fa = 1.5f, fb = -0.3f;
    float acc = 0.0f;
    for (int i = 1; i <= 50; i++) {
        acc = acc * fa + fb / (float)i;
        if (acc > 1000.0f) acc = acc - 999.5f;
    }
    line32("float_acc", fbits(acc));
    line32("float_to_int", (uint32_t)(int32_t)(acc * 100.0f));
    line32("int_to_float", fbits((float)(int32_t)-123456789));
    line32("uint_to_float", fbits((float)4000000000u));
    volatile double da = 3.141592653589793, db = 2.718281828459045;
    double d = 1.0;
    for (int i = 1; i <= 40; i++) {
        d = d * da / db + (double)i * 0.125;
        if (d > 1e6) d = d / 1024.0 - 1.0;
    }
    line64("double_acc", dbits(d));
    line64("double_sum", dbits(da + db));
    line64("double_div", dbits(da / db));
    line32("double_to_int", (uint32_t)(int32_t)(d * 0.001));
    line32("double_cmp", (uint32_t)(da > db) | ((uint32_t)(da < db) << 1) | ((uint32_t)(da == da) << 2));
    line32("float_from_double", fbits((float)(da * db)));
    line64("double_from_float", dbits((double)fa * 3.0));
    line64("double_from_int64", dbits((double)(int64_t)-1234567890123ll));
    line64("int64_from_double", (uint64_t)(int64_t)(da * 1e12));
}

/* -------------------------------------------------------- setjmp/varargs */
static jmp_buf env;
static void thrower(int depth)
{
    volatile uint32_t pad[4] = {1, 2, 3, 4};
    if (depth == 0) longjmp(env, (int)(pad[0] + pad[3] + 37u));
    thrower(depth - 1);
}
static int32_t sum_all(int count, ...)
{
    va_list ap;
    va_start(ap, count);
    int32_t s = 0;
    for (int i = 0; i < count; i++) s += va_arg(ap, int32_t) * (i + 1);
    va_end(ap);
    return s;
}
static void test_misc(void)
{
    volatile uint32_t before = 5;
    int r = setjmp(env);
    if (r == 0) {
        before = 9;
        thrower(6);
    }
    line32("setjmp", (uint32_t)r * 16u + before);
    line32("varargs", (uint32_t)sum_all(7, 3, -1, 4, 1, -5, 9, 2));

    uint32_t *blocks[6];
    uint32_t h = 0;
    for (int round = 0; round < 3; round++) {
        for (uint32_t i = 0; i < 6; i++) {
            uint32_t n = 8u + i * 12u;
            blocks[i] = (uint32_t *)malloc(n * sizeof(uint32_t));
            for (uint32_t k = 0; k < n; k++) blocks[i][k] = rng();
        }
        for (uint32_t i = 0; i < 6; i++) {
            uint32_t n = 8u + i * 12u;
            for (uint32_t k = 0; k < n; k++) h = mix(h, blocks[i][k]);
            free(blocks[i]);
        }
    }
    line32("malloc", h);
    put_str("dec=");
    put_dec(-2147483647 - 1);
    putchar(' ');
    put_dec(1234567890);
    putchar(' ');
    put_dec(0);
    putchar('\n');
}

int main(void)
{
    test_crc();
    test_int32();
    test_int64();
    test_sort();
    test_recursion();
    test_memory();
    test_structs();
    test_control();
    test_float();
    test_misc();
    put_str("done\n");
    fflush(stdout);
    return 0;
}
