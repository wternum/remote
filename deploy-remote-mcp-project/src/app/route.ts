import fs from 'node:fs';
import path from 'node:path';
import { constants, brotliCompressSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const dynamic = 'force-dynamic';

interface Asset {
  etags: { raw: string; gzip: string; br: string };
  raw: Uint8Array<ArrayBuffer>;
  gzip: Uint8Array<ArrayBuffer>;
  br: Uint8Array<ArrayBuffer>;
}

/** Buffer 可能来自 zlib 的共享池，复制到独立 ArrayBuffer 才能作为 Response body */
function toBody(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}

const MISSING_MESSAGE =
  'PULSEDESK SPA bundle is missing. Run `npm run build` (prepare-runtime + vite build + next build), or `npm run build:spa` for the frontend only.';

let asset: Asset | undefined;

/**
 * SPA 单文件（约 3.5MB）只读一次并预压缩。
 *
 * 缺失时不缓存 null（补齐构建产物后无需重启即可恢复）；不同内容编码各自使用独立 ETag。
 */
function loadAsset(): Asset | null {
  if (asset) return asset;
  const possiblePaths = [
    path.join(process.cwd(), 'dist', 'index.html'),
    path.join(process.cwd(), 'public', 'index.html'),
  ];
  for (const p of possiblePaths) {
    if (!fs.existsSync(p)) continue;
    const raw = toBody(fs.readFileSync(p));
    const hash = createHash('sha1').update(raw).digest('base64url');
    asset = {
      etags: {
        raw: `"${hash}-raw"`,
        gzip: `"${hash}-gzip"`,
        br: `"${hash}-br"`,
      },
      raw,
      // 质量 6 / 5：在 3.5MB 输入上压缩耗时可控（几十毫秒），只发生在首次请求
      gzip: toBody(gzipSync(raw, { level: 6 })),
      br: toBody(
        brotliCompressSync(raw, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
        }),
      ),
    };
    return asset;
  }
  return null;
}

function negotiateEncoding(acceptHeader: string): 'br' | 'gzip' | 'raw' {
  let br = 0;
  let gzip = 0;
  for (const part of acceptHeader.split(',')) {
    const [rawName, ...params] = part.trim().toLowerCase().split(';');
    if (!rawName) continue;
    let q = 1;
    for (const param of params) {
      const m = /^q\s*=\s*([0-9.]+)$/.exec(param.trim());
      if (m) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed)) q = Math.max(0, Math.min(1, parsed));
      }
    }
    if (rawName === 'br') br = q;
    else if (rawName === 'gzip') gzip = q;
  }
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return 'raw';
}

const baseHeaders = (etag: string) => ({
  etag,
  // 单文件 SPA 内容只随构建变化：允许缓存但每次用 ETag 复验（命中则 304）
  'cache-control': 'public, max-age=0, must-revalidate',
  vary: 'accept-encoding',
});

export async function GET(req: Request) {
  const current = loadAsset();
  if (!current) {
    // 两者都缺失说明 SPA 从未构建过，必须明确报错，而不是让前端一直等待“初始化”。
    return new Response(MISSING_MESSAGE, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const encoding = negotiateEncoding(req.headers.get('accept-encoding') ?? '');
  const etag = current.etags[encoding];
  const headers = baseHeaders(etag);
  const ifNoneMatch = req.headers.get('if-none-match');
  if (ifNoneMatch && ifNoneMatch.split(',').some(t => t.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }

  const type = 'text/html; charset=utf-8';
  if (encoding === 'br') {
    return new Response(current.br, {
      status: 200,
      headers: { ...headers, 'content-type': type, 'content-encoding': 'br' },
    });
  }
  if (encoding === 'gzip') {
    return new Response(current.gzip, {
      status: 200,
      headers: { ...headers, 'content-type': type, 'content-encoding': 'gzip' },
    });
  }
  return new Response(current.raw, {
    status: 200,
    headers: { ...headers, 'content-type': type },
  });
}
