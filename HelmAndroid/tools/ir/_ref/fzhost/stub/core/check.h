#pragma once
#include <stdio.h>
#include <stdlib.h>
#define furi_assert(...) do { } while(0)
#define furi_check(x, ...) do { if(!(x)) { fprintf(stderr, "furi_check failed %s:%d\n", __FILE__, __LINE__); exit(3);} } while(0)
#define furi_crash(...) do { fprintf(stderr, "furi_crash %s:%d\n", __FILE__, __LINE__); exit(4);} while(0)
