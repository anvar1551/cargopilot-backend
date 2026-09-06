import { Worker } from "worker_threads";

export const MAX_PROOF_BYTES = 6 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
let activeWorkers = 0;
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function proofSignaturePoints(value: unknown): Array<Array<{ x: number; y: number }>> {
  if (typeof value === "string") {
    if (value.length > 32768) throw fail("Signature exceeds limits");
    try { value = JSON.parse(value); } catch { throw fail("Invalid signature paths"); }
  }
  if (!Array.isArray(value) || !value.length || value.length > 64) throw fail("Signature paths are required and must be bounded");
  let total = 0;
  return value.map((stroke) => {
    if (typeof stroke !== "string" || stroke.length > 32768) throw fail("Invalid signature path");
    const points = stroke.split(";").filter((point) => point.trim());
    total += points.length;
    if (!points.length || total > 2048) throw fail("Signature exceeds point limits");
    return points.map((point) => {
      if (!/^\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*$/.test(point)) throw fail("Signature coordinates must be numeric");
      const [x, y] = point.split(",").map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x > 1024 || y > 512) throw fail("Signature coordinates exceed bounds");
      return { x, y };
    });
  });
}

export function validateProofPng(buffer: Buffer) {
  if (!buffer.length || buffer.length > MAX_PROOF_BYTES) throw fail("Proof image exceeds byte limits", 413);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") throw fail("Only PNG proof images are supported", 415);
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS) throw fail("Proof image dimensions exceed limits", 413);
  if (buffer[24] !== 8 || ![0, 2, 3, 4, 6].includes(buffer[25]) || buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] !== 0) {
    throw fail("Only non-interlaced 8-bit PNG proofs are supported", 415);
  }
  let offset = 8, chunks = 0, ended = false;
  while (offset + 12 <= buffer.length && ++chunks <= 4096) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (size > buffer.length - offset - 12 || ["acTL", "fcTL", "fdAT"].includes(type) || (type === "IHDR" && offset !== 8)) throw fail("Invalid or animated PNG proof");
    offset += size + 12;
    if (type === "IEND") { ended = size === 0 && offset === buffer.length; break; }
  }
  if (!ended) throw fail("Invalid PNG structure or trailing content");
  return { width, height };
}

// The codec executes away from the event loop. Only server code and a resolved installed
// module path are used; no uploaded script, path or SVG is executed/interpreted.
const workerSource = `
const { parentPort, workerData } = require("worker_threads");
try {
  const { PNG } = require(workerData.codec);
  const decoded = PNG.sync.read(Buffer.from(workerData.photo), { checkCRC: true });
  if (decoded.width !== workerData.width || decoded.height !== workerData.height || decoded.data.length !== decoded.width * decoded.height * 4) throw Error("dimensions");
  const photo = PNG.sync.write({ width: decoded.width, height: decoded.height, data: decoded.data }, { colorType: 6, inputColorType: 6, bitDepth: 8 });
  const strokes = workerData.strokes;
  const width = Math.ceil(Math.max(320, ...strokes.flat().map(p => p.x)) + 8);
  const height = Math.ceil(Math.max(160, ...strokes.flat().map(p => p.y)) + 8);
  const data = Buffer.alloc(width * height * 4, 255);
  const dot = (x,y) => {
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) {
      const px=Math.round(x)+dx, py=Math.round(y)+dy;
      if(px<0||py<0||px>=width||py>=height) continue;
      const i=(py*width+px)*4; data[i]=46;data[i+1]=107;data[i+2]=255;
    }
  };
  for(const stroke of strokes) for(let i=0;i<stroke.length;i++) {
    const a=stroke[Math.max(0,i-1)], b=stroke[i], steps=Math.max(1,Math.ceil(Math.max(Math.abs(b.x-a.x),Math.abs(b.y-a.y))));
    for(let t=0;t<=steps;t++) dot(a.x+(b.x-a.x)*t/steps,a.y+(b.y-a.y)*t/steps);
  }
  const signature=PNG.sync.write({width,height,data}, {colorType:6,inputColorType:6,bitDepth:8});
  if(photo.length>workerData.maxOutput || signature.length>workerData.maxOutput) throw Error("output limit");
  parentPort.postMessage({ photo, signature });
} catch { parentPort.postMessage({ error: true }); }
`;

export async function processProofRaster(photo: Buffer, signaturePaths: unknown): Promise<{ photo: Buffer; signature: Buffer }> {
  const dimensions = validateProofPng(photo);
  const strokes = proofSignaturePoints(signaturePaths);
  if (activeWorkers >= 2) throw fail("Proof processing capacity reached; retry later", 503);
  activeWorkers++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(workerSource, { eval: true, workerData: {
      codec: require.resolve("pngjs"), photo, strokes, ...dimensions, maxOutput: MAX_OUTPUT_BYTES,
    }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    const current = worker;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(fail("Proof processing timed out", 503)); void current.terminate(); }, 3000);
      const clean = () => clearTimeout(timer);
      current.once("message", (message) => {
        clean();
        if (message.error) reject(fail("Proof image decoding failed"));
        else resolve({ photo: Buffer.from(message.photo), signature: Buffer.from(message.signature) });
      });
      current.once("error", () => { clean(); reject(fail("Proof processing failed", 503)); });
      current.once("exit", () => { clean(); reject(fail("Proof processing stopped", 503)); });
    });
  } finally {
    // A timeout alone is not cancellation: keep the admission slot until worker termination.
    if (worker) await worker.terminate();
    activeWorkers--;
  }
}
