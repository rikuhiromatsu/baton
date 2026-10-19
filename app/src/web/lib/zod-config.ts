// main.tsx の最初に読み込む。CSP（script-src 'self'）の下で zod が new Function を試して違反を報告しないように、
// 共有パッケージのスキーマが作られる前に JIT を切る
import { z } from "zod";

z.config({ jitless: true });
