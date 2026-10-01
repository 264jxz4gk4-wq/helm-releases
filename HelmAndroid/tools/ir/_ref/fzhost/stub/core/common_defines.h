#pragma once
#ifndef COUNT_OF
#define COUNT_OF(x) (sizeof(x) / sizeof(x[0]))
#endif
#ifndef MAX
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#endif
#ifndef MIN
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#endif
