// Offline 1-D Barcode Decoder (Code 128)
// Used on devices without native BarcodeDetector (iOS Safari)
(function (global) {
  'use strict';

  const PATTERNS = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112'
  ];

  const PAT_MAP = {};
  PATTERNS.forEach((p, idx) => { PAT_MAP[p] = idx; });

  function decodeRuns(runs, isFirstBar) {
    if (!runs || runs.length < 13) return null;
    const startIdx = isFirstBar ? 0 : 1;
    for (let i = startIdx; i <= runs.length - 13; i += 2) {
      const s6 = runs.slice(i, i + 6);
      const total = s6.reduce((a, b) => a + b, 0);
      if (total < 11) continue;
      const mod = total / 11;
      const norm = s6.map((w) => Math.max(1, Math.min(4, Math.round(w / mod)))).join('');
      const code = PAT_MAP[norm];
      if (code === 103 || code === 104 || code === 105) {
        let mode = code;
        const decoded = [];
        let sum = code;
        let pos = 1;
        let idx = i + 6;
        let valid = false;

        while (idx + 6 <= runs.length) {
          if (idx + 7 <= runs.length) {
            const s7 = runs.slice(idx, idx + 7);
            const tot7 = s7.reduce((a, b) => a + b, 0);
            const m7 = tot7 / 13;
            const norm7 = s7.map((w) => Math.max(1, Math.min(4, Math.round(w / m7)))).join('');
            if (norm7 === '2331112') {
              if (decoded.length > 0) {
                const check = decoded.pop();
                sum -= check * (pos - 1);
                if (sum % 103 === check) {
                  valid = true;
                  break;
                }
              }
            }
          }
          const cur = runs.slice(idx, idx + 6);
          const curTot = cur.reduce((a, b) => a + b, 0);
          const curM = curTot / 11;
          const curNorm = cur.map((w) => Math.max(1, Math.min(4, Math.round(w / curM)))).join('');
          const sym = PAT_MAP[curNorm];
          if (sym === undefined) break;
          decoded.push(sym);
          sum += sym * pos;
          pos++;
          idx += 6;
        }

        if (valid && decoded.length > 0) {
          let str = '';
          for (const sym of decoded) {
            if (mode === 104) {
              if (sym >= 0 && sym <= 95) str += String.fromCharCode(sym + 32);
            } else if (mode === 105) {
              if (sym >= 0 && sym <= 99) str += String(sym).padStart(2, '0');
            } else if (mode === 103) {
              if (sym >= 0 && sym <= 63) str += String.fromCharCode(sym + 32);
              else if (sym >= 64 && sym <= 95) str += String.fromCharCode(sym - 64);
            }
          }
          if (str.length >= 4) return str;
        }
      }
    }
    return null;
  }

  function binarizeLine(pixels, width, y) {
    const rowOffset = y * width * 4;
    const lums = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const idx = rowOffset + x * 4;
      lums[x] = (pixels[idx] * 299 + pixels[idx + 1] * 587 + pixels[idx + 2] * 114) / 1000;
    }

    const windowSize = Math.max(8, Math.round(width / 32));
    const binary = new Uint8Array(width);
    let sum = 0;
    for (let x = 0; x < windowSize; x++) sum += lums[x];

    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - Math.floor(windowSize / 2));
      const right = Math.min(width - 1, x + Math.floor(windowSize / 2));
      const count = right - left + 1;
      let localSum = 0;
      for (let i = left; i <= right; i++) localSum += lums[i];
      const threshold = (localSum / count) * 0.92;
      binary[x] = lums[x] < threshold ? 1 : 0;
    }

    const runs = [];
    let cur = binary[0];
    let len = 0;
    for (let x = 0; x < width; x++) {
      if (binary[x] === cur) {
        len++;
      } else {
        runs.push(len);
        cur = binary[x];
        len = 1;
      }
    }
    runs.push(len);
    return { runs, isFirstBar: binary[0] === 1 };
  }

  let canvasCache = null;

  function decodeImage(source) {
    if (!source) return [];
    let width = source.videoWidth || source.naturalWidth || source.width;
    let height = source.videoHeight || source.naturalHeight || source.height;
    if (!width || !height) return [];

    const targetWidth = Math.min(800, width);
    const targetHeight = Math.round((height / width) * targetWidth);

    if (!canvasCache) {
      canvasCache = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    }
    if (!canvasCache) return [];

    canvasCache.width = targetWidth;
    canvasCache.height = targetHeight;
    const ctx = canvasCache.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
    const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    const pixels = imgData.data;

    const sampleYs = [0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8];
    for (const ratio of sampleYs) {
      const y = Math.floor(targetHeight * ratio);
      const { runs, isFirstBar } = binarizeLine(pixels, targetWidth, y);
      const text = decodeRuns(runs, isFirstBar);
      if (text) {
        return [{ rawValue: text, format: 'code_128' }];
      }
    }
    return [];
  }

  const BarcodeDecoder = {
    decode: decodeImage,
    decodeRuns: decodeRuns,
    binarizeLine: binarizeLine
  };

  if (typeof window !== 'undefined') {
    window.BarcodeDecoder = BarcodeDecoder;

    if (!('BarcodeDetector' in window)) {
      window.BarcodeDetector = class {
        static async getSupportedFormats() {
          return ['code_128', 'code_39', 'qr_code'];
        }
        constructor(options) {
          this.formats = (options && options.formats) || ['code_128'];
        }
        async detect(source) {
          return BarcodeDecoder.decode(source);
        }
      };
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BarcodeDecoder;
  }
})(typeof window !== 'undefined' ? window : global);
