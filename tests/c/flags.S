@ Flag-behaviour probes: uint32_t op(uint32_t a, uint32_t b, uint32_t apsr_in, uint32_t *apsr_out)
    .syntax unified
    .cpu cortex-m0
    .thumb
    .text

    .macro PROBE name
    .global \name
    .thumb_func
\name:
    push {r4, lr}
    msr APSR_nzcvq, r2
    .endm

    .macro DONE
    mrs r4, APSR
    str r4, [r3]
    pop {r4, pc}
    .endm

PROBE op_adds
    adds r0, r0, r1
    DONE
PROBE op_subs
    subs r0, r0, r1
    DONE
PROBE op_adcs
    adcs r0, r1
    DONE
PROBE op_sbcs
    sbcs r0, r1
    DONE
PROBE op_cmp
    cmp r0, r1
    DONE
PROBE op_cmn
    cmn r0, r1
    DONE
PROBE op_negs
    negs r0, r1
    DONE
PROBE op_lsls
    lsls r0, r1
    DONE
PROBE op_lsrs
    lsrs r0, r1
    DONE
PROBE op_asrs
    asrs r0, r1
    DONE
PROBE op_rors
    rors r0, r1
    DONE
PROBE op_muls
    muls r0, r1, r0
    DONE
PROBE op_ands
    ands r0, r1
    DONE
PROBE op_eors
    eors r0, r1
    DONE
PROBE op_orrs
    orrs r0, r1
    DONE
PROBE op_bics
    bics r0, r1
    DONE
PROBE op_mvns
    mvns r0, r1
    DONE
PROBE op_tst
    tst r0, r1
    DONE
PROBE op_lsl1
    lsls r0, r0, #1
    DONE
PROBE op_lsl31
    lsls r0, r0, #31
    DONE
PROBE op_lsr1
    lsrs r0, r0, #1
    DONE
PROBE op_lsr32
    lsrs r0, r0, #32
    DONE
PROBE op_asr1
    asrs r0, r0, #1
    DONE
PROBE op_asr32
    asrs r0, r0, #32
    DONE
PROBE op_movs
    movs r0, r1
    DONE
PROBE op_add3
    adds r0, r0, #7
    DONE
PROBE op_sub3
    subs r0, r0, #7
    DONE
PROBE op_add8
    adds r0, #255
    DONE
PROBE op_sub8
    subs r0, #255
    DONE
PROBE op_cmp8
    cmp r0, #200
    DONE
PROBE op_mov8
    movs r0, #0
    DONE
PROBE op_addhi
    mov r12, r1
    add r0, r12
    DONE
PROBE op_cmphi
    mov r12, r1
    cmp r0, r12
    DONE
PROBE op_sxtb
    sxtb r0, r1
    DONE
PROBE op_sxth
    sxth r0, r1
    DONE
PROBE op_uxtb
    uxtb r0, r1
    DONE
PROBE op_uxth
    uxth r0, r1
    DONE
PROBE op_rev
    rev r0, r1
    DONE
PROBE op_rev16
    rev16 r0, r1
    DONE
PROBE op_revsh
    revsh r0, r1
    DONE
