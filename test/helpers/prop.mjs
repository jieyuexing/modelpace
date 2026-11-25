// 零依赖的种子化生成式测试工具：mulberry32 伪随机 + forAll 跑若干样本。
// 默认种子固定，结果可复跑；PROP_SEED 覆盖种子，PROP_RUNS 覆盖样本数。
// 失败时报错信息里带种子、样本序号与样本本身，复跑同一种子即可重现。

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeGen(rand) {
  const gen = {
    rand,
    int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
    float: (lo, hi) => lo + rand() * (hi - lo),
    bool: (p = 0.5) => rand() < p,
    pick: (items) => items[Math.floor(rand() * items.length)],
    maybe: (value, p = 0.5) => (rand() < p ? value : null),
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    array: (lo, hi, make) => Array.from({ length: gen.int(lo, hi) }, (_, i) => make(i)),
  };
  return gen;
}

const DEFAULT_SEED = 20261125;

export function propSeed(fallback = DEFAULT_SEED) {
  const raw = process.env.PROP_SEED;
  return raw && Number.isSafeInteger(Number(raw)) ? Number(raw) : fallback;
}

/** 用固定种子生成 runs 个样本逐个检查；check 抛错时包上种子与样本再抛。 */
export function forAll(name, { runs = 200, seed = propSeed() } = {}, make, check) {
  const total = Number.isSafeInteger(Number(process.env.PROP_RUNS)) && Number(process.env.PROP_RUNS) > 0
    ? Number(process.env.PROP_RUNS)
    : runs;
  const gen = makeGen(mulberry32(seed));
  for (let index = 0; index < total; index++) {
    const sample = make(gen, index);
    try {
      check(sample, gen);
    } catch (error) {
      let shown;
      try {
        shown = JSON.stringify(sample, null, 2);
      } catch {
        shown = String(sample);
      }
      const wrapped = new Error(`${name}: failed at sample #${index} (PROP_SEED=${seed}): ${error.message}\nsample: ${shown}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }
}
