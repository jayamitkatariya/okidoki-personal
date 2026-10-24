// Sample scene specs for test.html. Each entry is a full Scene spec as documented in SPEC.md.
const PI = Math.PI;

// ---------- engine ----------
function engine() {
  const xs = [-1.8, -0.6, 0.6, 1.8];
  const parts = [
    { id: 'block', type: 'box', name: 'Engine block', description: 'Cast housing that holds the cylinders.', size: [5.2, 3, 1.7], position: [0, 1.4, 0], color: '#5B6472', metal: 0.5, rough: 0.5, opacity: 0.9, visible: false },
    { id: 'crank', type: 'group', name: 'Crankshaft', description: 'Converts the pistons\' reciprocating motion into rotation.', position: [0, 0, 0], visible: false },
    { id: 'crankShaft', type: 'cylinder', parent: 'crank', radius: 0.22, height: 5.6, rotation: [0, 0, PI / 2], color: '#B9C2CF', metal: 0.85, rough: 0.3 },
    { id: 'rods', type: 'group', name: 'Connecting rods', position: [0, 1.0, 0], visible: false },
    { id: 'pistons', type: 'group', name: 'Pistons', position: [0, 1.9, 0], visible: false },
    { id: 'plugs', type: 'group', name: 'Spark plugs', position: [0, 3.1, 0], visible: false },
    { id: 'lblBlock', type: 'label', text: 'Block', anchor: 'block', offset: [0, 2.0, 0], visible: false },
    { id: 'lblCrank', type: 'label', text: 'Crankshaft', anchor: 'crankShaft', offset: [3.2, -0.6, 0], visible: false },
    { id: 'lblPistons', type: 'label', text: 'Pistons', anchor: 'pistons', offset: [0, 1.6, 1.2], visible: false },
  ];
  xs.forEach((x, i) => {
    parts.push({ id: `throw${i}`, type: 'box', parent: 'crank', size: [0.35, 1.0, 0.5], position: [x, 0.3, 0], color: '#AAB3C0', metal: 0.85, rough: 0.3 });
    parts.push({ id: `rod${i}`, type: 'tube', parent: 'rods', name: `Rod ${i + 1}`, path: [[x, -0.45, 0], [x, 0.5, 0]], radius: 0.09, color: '#C8CFD9', metal: 0.8, rough: 0.35 });
    parts.push({ id: `piston${i}`, type: 'cylinder', parent: 'pistons', name: `Piston ${i + 1}`, description: 'Slides in the cylinder, driven by combustion.', radius: 0.46, height: 0.6, position: [x, 0, 0], color: '#E4E8EE', metal: 0.7, rough: 0.35 });
    parts.push({ id: `plug${i}`, type: 'cone', parent: 'plugs', radius: 0.12, height: 0.45, position: [x, 0, 0], color: '#F2F2F2', metal: 0.2, rough: 0.6 });
  });
  const osc = (i, amp) => ({ type: 'oscillate', id: `piston${i}`, axis: 'y', amplitude: amp, period: 1.0, on: true });
  const oscRod = (i, amp) => ({ type: 'oscillate', id: `rod${i}`, axis: 'y', amplitude: amp, period: 1.0, on: true });
  return {
    title: 'Inline-four engine', mode: '3d',
    camera: { position: [6.5, 4.5, 7.5], target: [0, 1.3, 0], fov: 42 },
    parts,
    beats: [
      { say: 'This is the engine block — the cast housing everything lives inside.', caption: 'Engine block', actions: [{ type: 'show', ids: ['block', 'lblBlock'], effect: 'fade' }, { type: 'xray', ids: ['block'], on: true }] },
      { say: 'At the bottom runs the crankshaft.', caption: 'Crankshaft', actions: [{ type: 'show', ids: ['crank', 'lblCrank'], effect: 'grow' }, { type: 'hide', ids: ['lblBlock'] }] },
      { say: 'Connecting rods link each crank throw to a piston.', caption: 'Connecting rods', actions: [{ type: 'show', ids: ['rods'], effect: 'drop' }] },
      { say: 'Four pistons slide up and down inside the cylinders.', caption: 'Pistons', actions: [{ type: 'show', ids: ['pistons', 'plugs', 'lblPistons'], effect: 'drop', seconds: 1.0 }, { type: 'hide', ids: ['lblCrank'] }] },
      { say: 'When the crank spins, the pistons move in pairs.', caption: 'Crank spins → pistons reciprocate', duration: 3,
        actions: [{ type: 'spin', id: 'crank', axis: 'x', rpm: 60, on: true }, osc(0, 0.45), osc(1, -0.45), osc(2, -0.45), osc(3, 0.45), oscRod(0, 0.45), oscRod(1, -0.45), oscRod(2, -0.45), oscRod(3, 0.45), { type: 'highlight', ids: ['pistons'], on: true }] },
      { say: 'Let\'s cut the block in half to see inside.', caption: 'Cutaway', actions: [{ type: 'highlight', ids: ['pistons'], on: false }, { type: 'xray', ids: ['block'], on: false }, { type: 'cutaway', axis: 'z', at: 0, on: true }, { type: 'camera', position: [3, 2.5, 8], target: [0, 1.3, 0] }] },
      { say: 'And here is the exploded view of every part.', caption: 'Exploded view', duration: 2.5, actions: [{ type: 'cutaway', axis: 'z', at: 0, on: false }, { type: 'spin', id: 'crank', axis: 'x', on: false }, { type: 'explode', factor: 0.9, seconds: 1.2 }, { type: 'orbit', on: true, rpm: 2 }] },
      { say: 'Back together.', caption: 'Reassembled', actions: [{ type: 'explode', factor: 0, seconds: 1.0 }, { type: 'orbit', on: false }, { type: 'camera', position: [6.5, 4.5, 7.5], target: [0, 1.3, 0] }] },
    ],
  };
}

// ---------- caffeine ----------
function caffeine() {
  const atoms = [
    ['N', 0, 1.39, 0], ['C', 1.2, 0.695, 0], ['N', 1.2, -0.695, 0], ['C', 0, -1.39, 0], ['C', -1.2, -0.695, 0], ['C', -1.2, 0.695, 0],
    ['N', -2.234, -1.62, 0], ['C', -1.67, -2.891, 0], ['N', -0.289, -2.748, 0], ['O', 2.265, 1.31, 0], ['O', -2.265, 1.31, 0],
    ['C', 0, 2.86, 0], ['C', 2.473, -1.43, 0], ['C', -3.67, -1.31, 0], ['H', -2.21, -3.82, 0],
    ['H', 0, 3.22, 1.03], ['H', 0.77, 3.22, -0.47], ['H', -0.77, 3.22, -0.47],
    ['H', 2.787, -1.61, 1.03], ['H', 3.17, -0.94, -0.47], ['H', 2.4, -2.28, -0.47],
    ['H', -4.03, -1.23, 1.03], ['H', -4.19, -1.99, -0.47], ['H', -3.86, -0.48, -0.47],
  ].map(([el, x, y, z]) => ({ el, pos: [x, y, z] }));
  const bonds = [[0, 1], [1, 2], [2, 3], [3, 4, 2], [4, 5], [5, 0], [3, 8], [8, 7, 2], [7, 6], [6, 4], [1, 9, 2], [5, 10, 2],
    [0, 11], [2, 12], [6, 13], [7, 14], [11, 15], [11, 16], [11, 17], [12, 18], [12, 19], [12, 20], [13, 21], [13, 22], [13, 23]];
  const groupOf = (el) => (el === 'N' ? 'nitrogens' : el === 'O' ? 'oxygens' : 'skeleton');
  const groups = { skeleton: [], nitrogens: [], oxygens: [] };
  const index = {};
  atoms.forEach((a, i) => { const g = groupOf(a.el); index[i] = [g, groups[g].length]; groups[g].push(a); });
  const parts = Object.entries(groups).map(([id, list]) => ({ id, type: 'molecule', name: { skeleton: 'Carbon skeleton', nitrogens: 'Nitrogen atoms', oxygens: 'Oxygen atoms' }[id], atoms: list, bonds: [], style: 'ball-stick', visible: false }));
  parts.push({ id: 'nbonds', type: 'group', visible: false }, { id: 'obonds', type: 'group', visible: false });
  bonds.forEach(([i, j, order = 1], k) => {
    const [gi, ii] = index[i], [gj, jj] = index[j];
    if (gi === gj) { parts.find((p) => p.id === gi).bonds.push([ii, jj, order]); return; }
    const parent = gi === 'oxygens' || gj === 'oxygens' ? 'obonds' : 'nbonds';
    parts.push({ id: `bond${k}`, type: 'tube', parent, path: [atoms[i].pos, atoms[j].pos], radius: order > 1 ? 0.1 : 0.07, color: '#D5D9E0' });
  });
  parts.push({ id: 'lblN', type: 'label', text: 'Nitrogen (N)', anchor: 'nitrogens', offset: [-2.4, 2.2, 0], visible: false });
  parts.push({ id: 'lblO', type: 'label', text: 'Oxygen (O)', anchor: 'oxygens', offset: [0, 2.0, 0], visible: false });
  return {
    title: 'Caffeine (C8H10N4O2)', mode: '3d', camera: { position: [0, -2, 11], target: [0, 0, 0], fov: 40 }, parts,
    beats: [
      { say: 'Caffeine is built on a carbon skeleton — two fused rings with three methyl groups.', caption: 'Carbon skeleton', actions: [{ type: 'show', ids: ['skeleton'], effect: 'grow', seconds: 0.9 }] },
      { say: 'Four nitrogen atoms sit inside the rings. They make caffeine an alkaloid.', caption: 'Nitrogen atoms', actions: [{ type: 'show', ids: ['nitrogens', 'nbonds', 'lblN'], effect: 'drop' }, { type: 'highlight', ids: ['nitrogens'], on: true }] },
      { say: 'Two oxygen atoms are double-bonded to carbons, forming carbonyl groups.', caption: 'Oxygen atoms', actions: [{ type: 'highlight', ids: ['nitrogens'], on: false }, { type: 'hide', ids: ['lblN'] }, { type: 'show', ids: ['oxygens', 'obonds', 'lblO'], effect: 'grow' }, { type: 'highlight', ids: ['oxygens'], on: true }, { type: 'pulse', ids: ['oxygens'] }] },
      { say: 'Here is the whole molecule.', caption: 'Caffeine', duration: 2, actions: [{ type: 'highlight', ids: ['oxygens'], on: false }, { type: 'hide', ids: ['lblO'] }, { type: 'orbit', on: true, rpm: 3 }, { type: 'camera', position: [4, 3, 9], target: [0, 0, 0] }] },
    ],
  };
}

// ---------- neural net ----------
function neuralNet() {
  const layers = [{ id: 'input', n: 4, x: -3, name: 'Input layer', color: '#7DD3FC' }, { id: 'hidden', n: 5, x: 0, name: 'Hidden layer', color: '#C4B5FD' }, { id: 'output', n: 3, x: 3, name: 'Output layer', color: '#FDBA74' }];
  const parts = [];
  const pos = {};
  layers.forEach((L) => {
    parts.push({ id: L.id, type: 'group', name: L.name, visible: false });
    for (let i = 0; i < L.n; i++) {
      const y = (i - (L.n - 1) / 2) * 1.2;
      pos[`${L.id}${i}`] = [L.x, y, 0];
      parts.push({ id: `${L.id}${i}`, type: 'sphere', parent: L.id, name: `${L.name} neuron ${i + 1}`, radius: 0.3, position: [L.x, y, 0], color: L.color, metal: 0.2, rough: 0.35 });
    }
    parts.push({ id: `lbl_${L.id}`, type: 'label', text: L.name, anchor: L.id, offset: [0, 3.4, 0], visible: false });
  });
  const connect = (a, b, gid) => {
    parts.push({ id: gid, type: 'group', name: 'Weights', visible: false });
    for (let i = 0; i < a.n; i++) for (let j = 0; j < b.n; j++) {
      parts.push({ id: `${gid}_${i}_${j}`, type: 'tube', parent: gid, path: [pos[`${a.id}${i}`], pos[`${b.id}${j}`]], radius: 0.025, color: '#8B93A3', metal: 0.3, rough: 0.5 });
    }
  };
  connect(layers[0], layers[1], 'w1');
  connect(layers[1], layers[2], 'w2');
  parts.push({ id: 'flow1', type: 'particles', path: [pos.input1, pos.hidden2, pos.output1], count: 20, speed: 2.5, size: 0.3, visible: false });
  parts.push({ id: 'flow2', type: 'particles', path: [pos.input2, pos.hidden1, pos.output0], count: 20, speed: 2.2, size: 0.3, visible: false });
  parts.push({ id: 'flow3', type: 'particles', path: [pos.input0, pos.hidden3, pos.output2], count: 20, speed: 2.8, size: 0.3, visible: false });
  return {
    title: 'Feed-forward neural network', mode: '3d', camera: { position: [0, 1.5, 10], target: [0, 0, 0], fov: 40 }, parts,
    beats: [
      { say: 'Data enters through the input layer — one neuron per feature.', caption: 'Input layer', actions: [{ type: 'show', ids: ['input', 'lbl_input'], effect: 'grow' }] },
      { say: 'Each input connects to every neuron in the hidden layer with a weight.', caption: 'Hidden layer', actions: [{ type: 'show', ids: ['w1'], effect: 'fade', seconds: 0.8 }, { type: 'show', ids: ['hidden', 'lbl_hidden'], effect: 'grow' }] },
      { say: 'The hidden layer feeds the output layer, which produces predictions.', caption: 'Output layer', actions: [{ type: 'show', ids: ['w2'], effect: 'fade', seconds: 0.8 }, { type: 'show', ids: ['output', 'lbl_output'], effect: 'grow' }] },
      { say: 'A forward pass sends activations through the network.', caption: 'Forward pass', duration: 3, actions: [{ type: 'show', ids: ['flow1', 'flow2', 'flow3'], effect: 'fade', seconds: 0.3 }, { type: 'flow', id: 'flow1', on: true }, { type: 'flow', id: 'flow2', on: true }, { type: 'flow', id: 'flow3', on: true }, { type: 'pulse', ids: ['hidden'] }] },
      { say: 'The output neurons hold the final answer.', caption: 'Prediction', actions: [{ type: 'highlight', ids: ['output'], on: true }, { type: 'camera', position: [4, 1.5, 7], target: [1.5, 0, 0] }] },
    ],
  };
}

// ---------- solar system ----------
function solarSystem() {
  const planets = [
    { id: 'mercury', name: 'Mercury', r: 0.14, orbit: 2.0, color: '#B5AFA6', rpm: 8 },
    { id: 'venus', name: 'Venus', r: 0.24, orbit: 3.1, color: '#E8C47A', rpm: 5 },
    { id: 'earth', name: 'Earth', r: 0.26, orbit: 4.4, color: '#4C8BF5', rpm: 3.2, description: 'Our home. Third planet from the Sun.' },
    { id: 'mars', name: 'Mars', r: 0.18, orbit: 5.6, color: '#D9633B', rpm: 2 },
  ];
  const parts = [{ id: 'sun', type: 'sphere', name: 'Sun', description: 'A G-type main-sequence star.', radius: 1.0, color: '#FFC43D', metal: 0, rough: 0.9, visible: false }];
  planets.forEach((p, i) => {
    parts.push({ id: `${p.id}Orbit`, type: 'ring', radius: p.orbit, visible: false });
    parts.push({ id: `${p.id}Pivot`, type: 'group', rotation: [0, i * 1.3, 0], visible: false });
    parts.push({ id: p.id, type: 'sphere', parent: `${p.id}Pivot`, name: p.name, description: p.description, radius: p.r, position: [p.orbit, 0, 0], color: p.color, metal: 0.05, rough: 0.7 });
    parts.push({ id: `${p.id}Label`, type: 'label', text: p.name, anchor: p.id, visible: false });
  });
  parts.push({ id: 'moonPivot', type: 'group', parent: 'earth', visible: true }, { id: 'moon', type: 'sphere', parent: 'moonPivot', name: 'Moon', radius: 0.07, position: [0.55, 0, 0], color: '#CFCFCF' });
  const spins = planets.map((p) => ({ type: 'spin', id: `${p.id}Pivot`, axis: 'y', rpm: p.rpm, on: true }));
  return {
    title: 'Inner solar system', mode: '3d', camera: { position: [0, 6, 11], target: [0, 0, 0], fov: 45 }, parts,
    beats: [
      { say: 'At the centre is the Sun, holding everything in its gravity.', caption: 'The Sun', actions: [{ type: 'show', ids: ['sun'], effect: 'grow', seconds: 0.9 }, { type: 'spin', id: 'sun', axis: 'y', rpm: 1, on: true }] },
      { say: 'The four rocky planets orbit on nearly circular paths.', caption: 'Inner planets', actions: [{ type: 'show', ids: planets.map((p) => `${p.id}Orbit`), effect: 'fade' }, { type: 'show', ids: planets.map((p) => `${p.id}Pivot`), effect: 'grow', seconds: 0.8 }] },
      { say: 'Closer planets move faster: Mercury laps the Sun four times for every Mars year.', caption: 'Orbital periods', duration: 4, actions: [...spins, { type: 'show', ids: planets.map((p) => `${p.id}Label`), effect: 'fade' }, { type: 'spin', id: 'moonPivot', axis: 'y', rpm: 30, on: true }] },
      { say: 'Seen from above, the orbits are nearly concentric circles.', caption: 'Top view', duration: 3, actions: [{ type: 'camera', position: [0, 13, 0.01], target: [0, 0, 0], seconds: 1.4 }] },
      { say: 'Earth sits in the habitable zone — not too hot, not too cold.', caption: 'Earth', duration: 3, actions: [{ type: 'highlight', ids: ['earth'], on: true }, { type: 'camera', position: [3, 4, 9], target: [0, 0, 0], seconds: 1.2 }] },
      { say: 'Let the system run.', caption: 'Orbiting', actions: [{ type: 'highlight', ids: ['earth'], on: false }, { type: 'orbit', on: true, rpm: 1.5 }] },
    ],
  };
}

// ---------- gear train ----------
function gearTrain() {
  const m = 1 / 6; // module (pitch diameter / teeth); meshing gears must share it
  const gears = [
    { id: 'driver', name: 'Driver (12T)', teeth: 12, color: '#D8DEE8' },
    { id: 'idler', name: 'Idler (18T)', teeth: 18, color: '#9FB3C8' },
    { id: 'driven', name: 'Driven (9T)', teeth: 9, color: '#44E45E' },
  ].map((g) => ({ ...g, r: (g.teeth * m) / 2 }));
  let x = 0;
  const xs = gears.map((g, i) => { if (i > 0) x += gears[i - 1].r + g.r; return x; });
  const shift = (xs[0] + xs[2]) / 2;
  const p = (g) => (2 * PI) / g.teeth;
  const phase = [-0.25 * p(gears[0]), PI - 0.75 * p(gears[1]), PI - 0.25 * p(gears[2])];
  const parts = [];
  gears.forEach((g, i) => {
    parts.push({ id: g.id, type: 'gear', name: g.name, description: `${g.teeth} teeth, pitch radius ${g.r.toFixed(2)}`, radius: g.r, teeth: g.teeth, thickness: 0.4, hole: 0.22, position: [xs[i] - shift, 0, 0], rotation: [0, 0, phase[i]], color: g.color, metal: 0.75, rough: 0.35, visible: false });
    parts.push({ id: `${g.id}Shaft`, type: 'cylinder', radius: 0.18, height: 1.2, rotation: [PI / 2, 0, 0], position: [xs[i] - shift, 0, 0], color: '#6B7280', metal: 0.8, rough: 0.3, visible: false });
    parts.push({ id: `${g.id}Label`, type: 'label', text: g.name, anchor: g.id, offset: [0, g.r + 0.5, 0], visible: false });
  });
  parts.push({ id: 'plate', type: 'box', size: [7, 4.5, 0.15], position: [0, 0, -0.5], color: '#2E343D', metal: 0.4, rough: 0.7, opacity: 0.8 });
  const rpm0 = 10;
  const rpm1 = -rpm0 * (gears[0].teeth / gears[1].teeth);
  const rpm2 = -rpm1 * (gears[1].teeth / gears[2].teeth);
  return {
    title: 'Gear train', mode: '3d', camera: { position: [1.5, 1.5, 7.5], target: [0, 0, 0], fov: 40 }, parts,
    beats: [
      { say: 'The driver gear has 12 teeth and is turned by a motor.', caption: 'Driver gear', actions: [{ type: 'show', ids: ['driver', 'driverShaft', 'driverLabel'], effect: 'grow' }] },
      { say: 'An 18-tooth idler meshes with it and reverses the direction.', caption: 'Idler gear', actions: [{ type: 'show', ids: ['idler', 'idlerShaft', 'idlerLabel'], effect: 'grow' }] },
      { say: 'Finally a small 9-tooth gear is driven by the idler.', caption: 'Driven gear', actions: [{ type: 'show', ids: ['driven', 'drivenShaft', 'drivenLabel'], effect: 'grow' }] },
      { say: 'Turn the driver at 10 rpm: the idler turns at 6.7 rpm the other way, and the driven gear at 13.3 rpm.', caption: 'Speed ratio 12 : 18 : 9', duration: 4,
        actions: [{ type: 'spin', id: 'driver', axis: 'z', rpm: rpm0, on: true }, { type: 'spin', id: 'idler', axis: 'z', rpm: rpm1, on: true }, { type: 'spin', id: 'driven', axis: 'z', rpm: rpm2, on: true }, { type: 'label', id: 'driverLabel', text: '10 rpm' }, { type: 'label', id: 'idlerLabel', text: '−6.7 rpm' }, { type: 'label', id: 'drivenLabel', text: '13.3 rpm' }] },
      { say: 'The idler changes direction but not the ratio — only tooth counts matter.', caption: 'Idler', duration: 3, actions: [{ type: 'highlight', ids: ['idler'], on: true }, { type: 'camera', position: [-1, 3.5, 5.5], target: [0, 0, 0] }] },
      { say: 'Here is the whole train from the side.', caption: 'Side view', actions: [{ type: 'highlight', ids: ['idler'], on: false }, { type: 'camera', position: [6, 1.5, 4], target: [0, 0, 0], seconds: 1.3 }] },
    ],
  };
}

// ---------- 2d plot ----------
function plot2d() {
  return {
    title: 'sin(x) vs x²/8', mode: '2d', camera: { position: [0, 0.5, 14], target: [0, 0.5, 0], fov: 45 },
    parts: [
      { id: 'grid', type: 'grid', size: 14, divisions: 14, visible: false },
      { id: 'axes', type: 'axes', size: 6.5, labels: ['x', 'y'], ticks: true, visible: false },
      { id: 'sin', type: 'plot', name: 'y = sin(x)', expr: 'sin(x)', xRange: [-6.3, 6.3], samples: 300, width: 0.06, visible: false },
      { id: 'para', type: 'plot', name: 'y = x²/8', expr: 'x^2/8', xRange: [-6, 6], samples: 200, width: 0.06, color: '#F59E0B', visible: false },
      { id: 'lblSin', type: 'label', text: 'y = sin(x)', anchor: 'sin', offset: [-4.7, 1.6, 0], visible: false },
      { id: 'lblPara', type: 'label', text: 'y = x² / 8', anchor: 'para', offset: [3.8, 1.5, 0], visible: false },
      { id: 'title', type: 'text', text: 'Two functions', size: 0.55, position: [0, 5.6, 0], visible: false },
      { id: 'cross', type: 'sphere', name: 'Intersection near x ≈ 2.37', radius: 0.12, position: [2.37, 0.70, 0.1], color: '#FFFFFF', visible: false },
    ],
    beats: [
      { say: 'Start with a coordinate grid and axes.', caption: 'Axes', actions: [{ type: 'show', ids: ['grid', 'axes', 'title'], effect: 'fade' }] },
      { say: 'The sine wave oscillates between −1 and 1 with a period of 2π.', caption: 'y = sin(x)', actions: [{ type: 'show', ids: ['sin', 'lblSin'], effect: 'fade', seconds: 0.9 }] },
      { say: 'The parabola x²/8 grows without bound.', caption: 'y = x²/8', actions: [{ type: 'show', ids: ['para', 'lblPara'], effect: 'fade', seconds: 0.9 }] },
      { say: 'They cross near x ≈ 2.37, where the parabola overtakes the sine.', caption: 'Crossing point', duration: 3, actions: [{ type: 'show', ids: ['cross'], effect: 'grow' }, { type: 'pulse', ids: ['cross'] }, { type: 'highlight', ids: ['cross', 'sin'], on: true }, { type: 'camera', position: [2.4, 0.8, 6], target: [2.4, 0.8, 0] }] },
      { say: 'Zoom back out to see the whole picture.', caption: 'Overview', actions: [{ type: 'highlight', ids: ['cross', 'sin'], on: false }, { type: 'camera', position: [0, 0.5, 14], target: [0, 0.5, 0] }] },
    ],
  };
}

// ---------- surface ----------
function surface() {
  return {
    title: 'z = sin(x)·cos(y)', mode: '3d', camera: { position: [7, 5, 8], target: [0, 0, 0], fov: 42 },
    parts: [
      { id: 'grid', type: 'grid', size: 10, divisions: 20, position: [0, -1.6, 0], visible: false },
      { id: 'axes', type: 'axes', size: 5, labels: ['x', 'z', 'y'], ticks: true, visible: false },
      { id: 'surf', type: 'surface', name: 'z = sin(x)·cos(y)', expr: 'sin(x)*cos(y)', xRange: [-4, 4], yRange: [-4, 4], segments: 96, colorBy: 'height', visible: false },
      { id: 'peak', type: 'label', text: 'Peak: z = 1 at (π/2, 0)', position: [1.57, 1.45, 0], visible: false },
      { id: 'peakDot', type: 'sphere', radius: 0.08, position: [1.5708, 1.0, 0], color: '#FFFFFF', visible: false },
    ],
    beats: [
      { say: 'A surface plots one output for every pair of inputs x and y.', caption: 'Axes', actions: [{ type: 'show', ids: ['grid', 'axes'], effect: 'fade' }] },
      { say: 'Here is z = sin(x)·cos(y); colour follows height, blue low and orange high.', caption: 'z = sin(x)·cos(y)', actions: [{ type: 'show', ids: ['surf'], effect: 'grow', seconds: 1.0 }] },
      { say: 'The highest point of 1 sits at x = π/2, y = 0.', caption: 'Maximum', duration: 3, actions: [{ type: 'show', ids: ['peak', 'peakDot'], effect: 'grow' }, { type: 'pulse', ids: ['peakDot'] }, { type: 'camera', position: [4, 4, 6], target: [1.5, 0.5, 0] }] },
      { say: 'From the top, the ripples form a checkerboard.', caption: 'Top view', duration: 3, actions: [{ type: 'hide', ids: ['peak', 'peakDot'] }, { type: 'camera', position: [0, 12, 0.01], target: [0, 0, 0], seconds: 1.4 }] },
      { say: 'Wireframe reveals the mesh underneath.', caption: 'Wireframe', duration: 3, actions: [{ type: 'xray', ids: ['surf'], on: true }, { type: 'camera', position: [7, 5, 8], target: [0, 0, 0], seconds: 1.4 }, { type: 'orbit', on: true, rpm: 2 }] },
      { say: 'Back to the solid surface.', caption: 'Solid', actions: [{ type: 'xray', ids: ['surf'], on: false }, { type: 'orbit', on: false }] },
    ],
  };
}

// ---------- exploded view ----------
function exploded() {
  const parts = [
    { id: 'base', type: 'box', name: 'Base plate', size: [3, 0.3, 2], position: [0, 0, 0], color: '#4B5563', metal: 0.5, rough: 0.5 },
    { id: 'body', type: 'box', name: 'Housing', size: [2.4, 1.2, 1.6], position: [0, 0.8, 0], color: '#9CA3AF', metal: 0.6, rough: 0.4 },
    { id: 'core', type: 'cylinder', name: 'Core', description: 'The part that does the work.', radius: 0.5, height: 1.0, position: [0, 0.8, 0], color: '#44E45E', metal: 0.3, rough: 0.4, visible: false },
    { id: 'lid', type: 'box', name: 'Cover', size: [2.6, 0.25, 1.8], position: [0, 1.55, 0], color: '#D1D5DB', metal: 0.6, rough: 0.35 },
    { id: 'knob', type: 'cylinder', name: 'Knob', radius: 0.25, height: 0.4, position: [0, 1.9, 0], color: '#F59E0B', metal: 0.4, rough: 0.5 },
    { id: 'spring', type: 'spring', name: 'Spring', radius: 0.18, height: 0.8, coils: 7, tube: 0.03, position: [0.9, 0.8, 0.5], color: '#C8CFD9', visible: false },
    { id: 'lblLid', type: 'label', text: 'Cover', anchor: 'lid', offset: [2.2, 0.6, 0] },
    { id: 'lblBase', type: 'label', text: 'Base plate', anchor: 'base', offset: [2.2, -0.6, 0] },
    { id: 'lblCore', type: 'label', text: 'Core', anchor: 'core', offset: [-2.0, 0.8, 0], visible: false },
  ];
  [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => parts.push({ id: `bolt${sx}${sz}`, type: 'cylinder', name: 'Bolt', radius: 0.08, height: 0.6, position: [sx * 1.1, 1.75, sz * 0.7], color: '#374151', metal: 0.8, rough: 0.3 })));
  return {
    title: 'Exploded assembly', mode: '3d', camera: { position: [5, 4, 6], target: [0, 0.9, 0], fov: 42 }, parts,
    beats: [
      { say: 'Here is the assembled device.', caption: 'Assembled', actions: [{ type: 'pulse', ids: ['lid'] }] },
      { say: 'Pull it apart to see how the pieces stack.', caption: 'Exploded ×0.8', duration: 2.5, actions: [{ type: 'explode', factor: 0.8, seconds: 1.2 }] },
      { say: 'Inside the housing is the core, with a return spring beside it.', caption: 'Core', duration: 3, actions: [{ type: 'xray', ids: ['body'], on: true }, { type: 'show', ids: ['core', 'spring', 'lblCore'], effect: 'grow' }, { type: 'highlight', ids: ['core'], on: true }] },
      { say: 'Spread it out further to see every bolt.', caption: 'Exploded ×1.6', duration: 2.5, actions: [{ type: 'highlight', ids: ['core'], on: false }, { type: 'xray', ids: ['body'], on: false }, { type: 'explode', factor: 1.6, seconds: 1.2 }, { type: 'orbit', on: true, rpm: 2 }] },
      { say: 'And back together.', caption: 'Reassembled', actions: [{ type: 'orbit', on: false }, { type: 'explode', factor: 0, seconds: 1.0 }, { type: 'camera', position: [5, 4, 6], target: [0, 0.9, 0] }] },
    ],
  };
}

export const SAMPLES = {
  engine: engine(),
  molecule: caffeine(),
  'neural net': neuralNet(),
  'solar system': solarSystem(),
  'gear train': gearTrain(),
  '2d plot': plot2d(),
  surface: surface(),
  'exploded view': exploded(),
};
export default SAMPLES;
