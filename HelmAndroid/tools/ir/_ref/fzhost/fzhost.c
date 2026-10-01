/* Host harness around the Flipper Zero firmware's lib/infrared encoder/decoder (GPLv3).
 * enc mode:  stdin lines "PROTO ADDR CMD TIMES" (hex addr/cmd) -> "OK freq dur1 dur2 ..." (mark first)
 * dec mode:  stdin lines "d1 d2 d3 ..." (raw, mark first) -> decoded messages */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "infrared.h"
static void enc_line(char* line) {
    char pname[32]; unsigned long addr, cmd; int times;
    if(sscanf(line, "%31s %lx %lx %d", pname, &addr, &cmd, &times) != 4) { printf("ERR parse\n"); return; }
    InfraredProtocol p = infrared_get_protocol_by_name(pname);
    if(p == InfraredProtocolUnknown) { printf("ERR proto\n"); return; }
    uint8_t al = infrared_get_protocol_address_length(p), cl = infrared_get_protocol_command_length(p);
    if((al < 32 && addr >= (1UL << al)) || (cl < 32 && cmd >= (1UL << cl))) { printf("ERR range\n"); return; }
    InfraredMessage m = {.protocol = p, .address = (uint32_t)addr, .command = (uint32_t)cmd, .repeat = false};
    InfraredEncoderHandler* h = infrared_alloc_encoder();
    infrared_reset_encoder(h, &m);
    int n = times; int minr = infrared_get_protocol_min_repeat_count(p); if(minr > n) n = minr;
    static uint32_t d[20000]; static int lv[20000]; int k = 0;
    while(n > 0 && k < 19990) {
        uint32_t dur; bool level;
        InfraredStatus st = infrared_encode(h, &dur, &level);
        if(st == InfraredStatusError) break;
        if(k > 0 && lv[k-1] == level) d[k-1] += dur; else { d[k] = dur; lv[k] = level; k++; }
        if(st == InfraredStatusDone) n--;
    }
    infrared_free_encoder(h);
    int s = 0; while(s < k && !lv[s]) s++; /* strip leading silence */
    int e = k; while(e > s && !lv[e-1]) e--; /* strip trailing space */
    printf("OK %u", (unsigned)infrared_get_protocol_frequency(p));
    for(int i = s; i < e; i++) printf(" %u", (unsigned)d[i]);
    printf("\n");
}
static void dec_line(char* line) {
    InfraredDecoderHandler* h = infrared_alloc_decoder();
    char* tok = strtok(line, " \t\n"); bool level = true; int any = 0;
    while(tok) {
        uint32_t dur = strtoul(tok, NULL, 10);
        const InfraredMessage* m = infrared_decode(h, level, dur);
        if(m) { printf("%s%s 0x%lX 0x%lX%s", any++ ? "; " : "", infrared_get_protocol_name(m->protocol), (unsigned long)m->address, (unsigned long)m->command, m->repeat ? " R" : ""); }
        level = !level; tok = strtok(NULL, " \t\n");
    }
    const InfraredMessage* m = infrared_decode(h, level, 200000);
    if(m) { printf("%s%s 0x%lX 0x%lX%s", any++ ? "; " : "", infrared_get_protocol_name(m->protocol), (unsigned long)m->address, (unsigned long)m->command, m->repeat ? " R" : ""); }
    m = infrared_check_decoder_ready(h);
    if(m) { printf("%s%s 0x%lX 0x%lX%s", any++ ? "; " : "", infrared_get_protocol_name(m->protocol), (unsigned long)m->address, (unsigned long)m->command, m->repeat ? " R" : ""); }
    if(!any) printf("NONE");
    printf("\n");
    infrared_free_decoder(h);
}
int main(int argc, char** argv) {
    int dec = argc > 1 && !strcmp(argv[1], "dec");
    static char line[200000];
    while(fgets(line, sizeof line, stdin)) { if(dec) dec_line(line); else enc_line(line); fflush(stdout); }
    return 0;
}
