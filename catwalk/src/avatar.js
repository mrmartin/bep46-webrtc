// Simple graphics: a cat face as inline SVG, from the profile's fur and eye
// colour plus a little per-key variation. No images, no network.

const FUR_COLORS = {
  ginger: ['#e49a4a', '#c97f32'], grey: ['#9a9ea3', '#7c8085'], black: ['#35343a', '#222126'],
  white: ['#f3efe6', '#d9d3c6'], tabby: ['#b98a55', '#8f6538'], calico: ['#f3efe6', '#d9d3c6'],
  siamese: ['#efe2cf', '#6b4e3d'], tuxedo: ['#35343a', '#f3efe6'],
};
const EYE_COLORS = { green: '#5fae5a', amber: '#e3a23a', blue: '#5b9bd5', copper: '#b8642d', odd: null };

function hashBits(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/** @returns {string} an <svg> element, 64×64 viewBox, scaled by CSS. */
export function catSvg({ fur = 'tabby', eyes = 'green', seed = '' } = {}, size = 48) {
  const [base, dark] = FUR_COLORS[fur] || FUR_COLORS.tabby;
  const h = hashBits(seed);
  const tilt = (h & 7) - 3;                 // head tilt, −3..4 degrees
  const earSpread = 20 + (h >> 3 & 3);      // ear width
  const leftEye = eyes === 'odd' ? EYE_COLORS.blue : (EYE_COLORS[eyes] || EYE_COLORS.green);
  const rightEye = eyes === 'odd' ? EYE_COLORS.green : leftEye;
  const pupil = (h >> 5 & 1) ? 1.6 : 2.4;   // slit vs round
  let markings = '';
  if (fur === 'tabby') markings = `<path d="M24 14 l3 8 M32 12 v9 M40 14 l-3 8" stroke="${dark}" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
  if (fur === 'calico') markings = `<path d="M18 22 q10 -8 16 2 q-6 6 -16 -2z" fill="#e49a4a"/><path d="M36 20 q10 -4 10 8 q-8 4 -10 -8z" fill="#35343a"/>`;
  if (fur === 'siamese') markings = `<ellipse cx="32" cy="38" rx="9" ry="7" fill="${dark}" opacity="0.85"/>`;
  if (fur === 'tuxedo') markings = `<path d="M26 44 q6 6 12 0 l-2 10 h-8z" fill="${dark}"/>`;
  const earInner = '#e8a0a8';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="cat avatar">
<g transform="rotate(${tilt} 32 36)">
<path d="M12 30 L10 8 L${12 + earSpread} 16z" fill="${base}"/><path d="M52 30 L54 8 L${52 - earSpread} 16z" fill="${base}"/>
<path d="M14 26 L13 12 L${13 + earSpread - 6} 18z" fill="${earInner}"/><path d="M50 26 L51 12 L${51 - earSpread + 6} 18z" fill="${earInner}"/>
<ellipse cx="32" cy="36" rx="22" ry="20" fill="${base}"/>
${markings}
<ellipse cx="23" cy="34" rx="4.5" ry="5" fill="${leftEye}"/><ellipse cx="41" cy="34" rx="4.5" ry="5" fill="${rightEye}"/>
<ellipse cx="23" cy="34" rx="${pupil}" ry="4" fill="#111"/><ellipse cx="41" cy="34" rx="${pupil}" ry="4" fill="#111"/>
<path d="M29 42 h6 l-3 3z" fill="#e8a0a8"/>
<path d="M32 45 v2 M32 47 q-3 3 -6 1 M32 47 q3 3 6 1" stroke="#333" stroke-width="1.3" fill="none" stroke-linecap="round"/>
<path d="M6 40 h16 M6 45 l16 -2 M58 40 h-16 M58 45 l-16 -2" stroke="#444" stroke-width="1" opacity="0.7"/>
</g></svg>`;
}

export { FUR_COLORS, EYE_COLORS };
