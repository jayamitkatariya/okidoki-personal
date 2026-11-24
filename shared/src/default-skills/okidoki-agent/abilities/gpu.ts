import type { OkidokiAgentAbilityDescriptor } from '../types';
import { COMPUTE_SANDBOX_LIMITS, COMPUTE_SANDBOX_WORKDIRS, DEFAULT_GPU_IMAGE, DEFAULT_GPU_TYPE, GPU_TYPES } from '../../../routes/compute';

const COMPUTE_SANDBOX_WORKDIR = COMPUTE_SANDBOX_WORKDIRS.gpu;

const SECTION = `### GPU sandboxes
Run GPU workloads (training, inference, CUDA builds, rendering) on cloud GPU sandboxes with \`okidoki gpu\`. The workspace itself has no GPU, but GPU sandboxes are available when a task needs one.

**Reference:** \`references/GPU.md\`

Use this when:
- A task needs a GPU: training or fine-tuning, model inference, CUDA code, benchmarks, or GPU rendering
- You need to verify GPU code actually runs instead of only writing it`;

const REFERENCE = `# GPU sandboxes

\`okidoki gpu\` starts cloud GPU sandboxes and runs commands in them. It is authenticated automatically, and usage is billed at cost to the organization, so stop sandboxes when you are done.

## One-shot runs

\`\`\`bash
okidoki gpu run --pull outputs -- python train.py
\`\`\`

This starts a sandbox, copies the current directory to \`${COMPUTE_SANDBOX_WORKDIR}\` (git repositories honor \`.gitignore\`), streams the command's output, copies \`${COMPUTE_SANDBOX_WORKDIR}/outputs\` back to \`./outputs\`, stops the sandbox, and exits with the command's exit code. Add \`--keep\` to leave it running.

## Interactive sessions

\`\`\`bash
okidoki gpu create                                # waits until running
okidoki gpu push                                  # . -> ${COMPUTE_SANDBOX_WORKDIR}
okidoki gpu exec -- nvidia-smi
okidoki gpu exec -- pip install -r requirements.txt
okidoki gpu exec --detach -- python train.py      # prints a job ID
okidoki gpu logs <jobId> -f                       # streams until the job exits
okidoki gpu pull ${COMPUTE_SANDBOX_WORKDIR}/checkpoints ./
okidoki gpu delete
\`\`\`

- Commands run with \`sh -c\` in \`${COMPUTE_SANDBOX_WORKDIR}\`; quote shell operators: \`okidoki gpu exec -- "cd src && make"\`.
- \`--sandbox <id>\` picks a sandbox when more than one is running; \`okidoki gpu list\` shows them.
- Use \`--detach\` and \`logs -f\` for anything longer than a few minutes. A foreground \`exec\` dies with its connection.
- \`--port 8000\` on create exposes a container port as a public HTTPS URL (shown by \`list\`).
- \`--env KEY=value\` passes secrets such as \`HF_TOKEN\`; never bake them into files you push.

## GPU-accelerated browser

The workspace's browser renders WebGL in software. Chrome in a GPU sandbox also uses software rendering unless it gets the flags below. If you need a page rendered on a real GPU, push a production build and serve it inside the sandbox. The sandbox carries no Okidoki login, so it can only open a preview URL (\`references/PREVIEWS.md\`) created without \`--authenticated\`, which anyone with the link can open: ask the user before making a private app public that way, and never recreate an existing authenticated preview without the flag. Then run Playwright in a GPU sandbox:

\`\`\`bash
mkdir -p /tmp/gpu-browser && cd /tmp/gpu-browser
cat > fps.mjs <<'EOF'
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
// Without these flags Chrome falls back to SwiftShader, a software renderer.
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(process.argv[2], { waitUntil: 'networkidle' });
const result = await page.evaluate(async () => {
  const gl = document.createElement('canvas').getContext('webgl');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'no WebGL';
  const frames = [];
  await new Promise((done) => {
    const tick = (t) => { frames.push(t); frames.at(-1) - frames[0] < 5000 ? requestAnimationFrame(tick) : done(); };
    requestAnimationFrame(tick);
  });
  const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  return { renderer, fps: Math.round((frames.length - 1) / 5), p95FrameMs: Math.round(gaps[Math.floor(gaps.length * 0.95)]) };
});
console.log(JSON.stringify(result));
mkdirSync('outputs', { recursive: true });
await page.screenshot({ path: 'outputs/frame.png' });
await browser.close();
EOF
okidoki gpu run --image mcr.microsoft.com/playwright:v1.49.0-noble --pull outputs -- "npm i playwright@1.49.0 >/dev/null && node fps.mjs https://<preview-url>/<page>"
\`\`\`

Check that \`renderer\` names the NVIDIA GPU; one naming SwiftShader means the page ran in software. \`fps\` counts the browser's frame callbacks, which is the most the page can draw; a game that skips frames draws fewer, so read its own frame counter (or count calls to its render function) when it has one. Add the interactions the page needs (clicks, waits for a scene to load) before measuring, and keep the Playwright package version matching the image tag.

## Choosing hardware and images

- GPUs, picked with \`--gpu\`: ${GPU_TYPES.join(', ')} (default ${DEFAULT_GPU_TYPE}). Add a count for multi-GPU, e.g. \`H100:4\` (max ${COMPUTE_SANDBOX_LIMITS.maxGpuCount}). Pick the smallest GPU that fits: T4/L4 for small models and smoke tests, A100/H100 for real training.
- Default image: \`${DEFAULT_GPU_IMAGE}\`. Pass any public registry image with \`--image\`; the first start of a new image takes a few minutes to pull.
- The sandbox has internet access. Download datasets and weights inside it rather than pushing them; pushes and pulls are capped at ${COMPUTE_SANDBOX_LIMITS.maxTransferBytes / 1024 ** 3} GiB.

## Limits

- ${COMPUTE_SANDBOX_LIMITS.maxActivePerWorkspace} running sandboxes per workspace and ${COMPUTE_SANDBOX_LIMITS.maxActivePerOrganization} per organization
- Lifetime 1 hour by default, up to 24 hours with \`--timeout\`
- Sandboxes stop after 10 minutes with no running command (\`--idle-timeout\`, up to 1 hour)
- Sandboxes stop when this workspace sleeps, is archived, or is deleted, and their files are lost; pull results before finishing
`;

export const GPU_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'GPU sandboxes',
  description: 'Run training, inference, and other GPU workloads on cloud GPUs with `okidoki gpu`.',
  bullet: '- Running GPU workloads (training, inference, CUDA, rendering) on cloud GPU sandboxes with `okidoki gpu` (this workspace has no GPU of its own)',
  section: SECTION,
  referenceFile: { name: 'GPU.md', content: REFERENCE },
};
