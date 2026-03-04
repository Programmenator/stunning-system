import { runCommand } from './command-service.js';

// Reads GPU memory usage via nvidia-smi and returns normalized JSON records.
export async function getGpuStatus() {
  const output = await runCommand('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.used,memory.free',
    '--format=csv,noheader,nounits'
  ]);

  return output
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, name, total, used, free] = line.split(',').map((x) => x.trim());
      return {
        index: Number(index),
        name,
        totalMB: Number(total),
        usedMB: Number(used),
        freeMB: Number(free)
      };
    });
}
