/* Drives the probes in flags.S over a matrix of edge-case operands and prints result + flags. */
#include <stdint.h>
#include <stdio.h>

typedef uint32_t (*probe_t)(uint32_t a, uint32_t b, uint32_t apsr_in, uint32_t *apsr_out);

#define OPS(X) \
    X(adds) X(subs) X(adcs) X(sbcs) X(cmp) X(cmn) X(negs) X(lsls) X(lsrs) X(asrs) X(rors) X(muls) \
    X(ands) X(eors) X(orrs) X(bics) X(mvns) X(tst) X(lsl1) X(lsl31) X(lsr1) X(lsr32) X(asr1) X(asr32) \
    X(movs) X(add3) X(sub3) X(add8) X(sub8) X(cmp8) X(mov8) X(addhi) X(cmphi) \
    X(sxtb) X(sxth) X(uxtb) X(uxth) X(rev) X(rev16) X(revsh)

#define DECL(n) uint32_t op_##n(uint32_t, uint32_t, uint32_t, uint32_t *);
OPS(DECL)

static const struct { const char *name; probe_t fn; } ops[] = {
#define ENTRY(n) {#n, op_##n},
    OPS(ENTRY)
};

static const uint32_t values[] = {
    0x00000000u, 0x00000001u, 0x00000002u, 0x0000001fu, 0x00000020u, 0x00000021u, 0x000000ffu, 0x00000100u,
    0x00007fffu, 0x00008000u, 0x7fffffffu, 0x80000000u, 0x80000001u, 0xfffffffeu, 0xffffffffu, 0x12345678u,
    0x000000c8u, 0x00000007u, 0xa5a5a5a5u, 0x000000e1u,
};
static const uint32_t flags_in[] = {0x00000000u, 0x20000000u, 0xd0000000u, 0xf0000000u};

static void hex(uint32_t v)
{
    static const char d[] = "0123456789abcdef";
    for (int i = 28; i >= 0; i -= 4) putchar(d[(v >> i) & 15u]);
}

int main(void)
{
    const unsigned nv = sizeof values / sizeof values[0];
    for (unsigned o = 0; o < sizeof ops / sizeof ops[0]; o++) {
        for (unsigned i = 0; i < nv; i++) {
            for (unsigned j = 0; j < nv; j++) {
                for (unsigned f = 0; f < 4; f++) {
                    uint32_t out = 0;
                    uint32_t res = ops[o].fn(values[i], values[j], flags_in[f], &out);
                    fputs(ops[o].name, stdout);
                    putchar(' '); hex(values[i]);
                    putchar(' '); hex(values[j]);
                    putchar(' '); putchar("0123456789abcdef"[flags_in[f] >> 28]);
                    putchar(' '); hex(res);
                    putchar(' '); putchar("0123456789abcdef"[out >> 28]);
                    putchar('\n');
                }
            }
        }
    }
    fflush(stdout);
    return 0;
}
