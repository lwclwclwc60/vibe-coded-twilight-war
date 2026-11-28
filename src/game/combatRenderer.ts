import { clamp } from './geometry';
import { drawShadowForms } from './skillRenderer';
import { EAGLE_EYE_DURATION, GUNFIRE_ANIMATION_SECONDS, ROYAL_SHIELD_PADDING } from './tuning';
import {
  BeamTracer,
  CharacterSkin,
  FloatingText,
  GunKind,
  MeleeKind,
  Particle,
  PickupItem,
  ShadowDodge,
  SlashEffect,
} from './types';

export interface CharacterRenderParams {
  x: number;
  y: number;
  radius: number;
  angle: number;
  bodyColor: string;
  role: 'PLAYER' | 'ALLY' | 'ENEMY';
  holdingMelee: boolean;
  shadowActive: boolean;
  time: number;
  isReloading?: boolean;
  reloadProgress?: number;
  isBlinded?: boolean;
  gunKind?: GunKind;
  meleeKind?: MeleeKind;
  skin?: CharacterSkin;
  walkPhase?: number;
  moveIntensity?: number;
  swapProgress?: number;
  attackAnimProgress?: number;
  attackAnimKind?: MeleeKind | null;
  gunfireTimer?: number;
  eagleEyeRemaining?: number;
  shadowDodge?: ShadowDodge;
  morphScale?: number;
  isPhantomClone?: boolean;
  isFrozen?: boolean;
}

export function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size = 12,
  align: CanvasTextAlign = 'left',
  strokeColor = 'rgba(0, 0, 0, 0.85)',
  fontFamily = '"Noto Sans TC", "JetBrains Mono", sans-serif',
  weight = 700,
  outlineWidth = 3.2
) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${fontFamily}`;
  ctx.textAlign = align;
  ctx.lineWidth = outlineWidth;
  ctx.strokeStyle = strokeColor;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function drawHand(
  ctx: CanvasRenderingContext2D,
  hx: number,
  hy: number,
  r: number,
  handColor: string
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(hx, hy, r, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(hx - r * 0.3, hy - r * 0.3, r * 0.1, hx, hy, r);
  g.addColorStop(0, '#FFFFFF');
  g.addColorStop(0.4, handColor);
  g.addColorStop(1, handColor);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = '#020617';
  ctx.lineWidth = 2.0;
  ctx.stroke();
  ctx.restore();
}

export function drawMuzzleFlash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  intensity: number
) {
  if (intensity <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha *= intensity;
  ctx.fillStyle = '#F59E0B';
  ctx.beginPath();
  ctx.moveTo(-2, 0);
  ctx.lineTo(4, -6);
  ctx.lineTo(9, -2);
  ctx.lineTo(20, 0);
  ctx.lineTo(9, 2);
  ctx.lineTo(4, 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#FFF0B3';
  ctx.beginPath();
  ctx.ellipse(5, 0, 8, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawSlashEffect(ctx: CanvasRenderingContext2D, s: SlashEffect) {
  const progress = clamp(1 - s.life / s.maxLife, 0, 1);
  const alpha = clamp(s.life / s.maxLife, 0, 1);
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.angle);
  ctx.globalAlpha = alpha;

  if (s.style === 'thrust') {
    const thrustLen = s.reach * (0.65 + 0.45 * progress);
    ctx.beginPath();
    ctx.moveTo(16, -8);
    ctx.lineTo(thrustLen + 12, 0);
    ctx.lineTo(16, 8);
    ctx.closePath();
    ctx.fillStyle = `${s.color}99`;
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else if (s.style === 'claw') {
    const clawReach = s.reach * (0.72 + 0.35 * progress);
    for (const oy of [-11, 0, 11]) {
      ctx.beginPath();
      ctx.arc(10 + progress * 8, oy, clawReach * 0.78, -0.5, 0.5);
      ctx.strokeStyle = oy === 0 ? '#FFFFFF' : s.color;
      ctx.lineWidth = oy === 0 ? 3.5 : 2.5;
      ctx.stroke();
    }
  } else {
    // 由左至右順時針弧形刀光軌跡（由角色左側負角掃向右側正角）
    const startAng = -s.arc / 2;
    const curEnd = s.isUltimate
      ? s.arc / 2
      : startAng + s.arc * clamp(progress * 1.25, 0.18, 1.0);
    const trailStart = s.isUltimate ? startAng : Math.max(startAng, curEnd - s.arc * 0.72);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, s.reach, trailStart, curEnd, false);
    ctx.closePath();
    ctx.fillStyle = `${s.color}${s.isUltimate ? '66' : '38'}`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, s.reach, trailStart, curEnd, false);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = s.isUltimate ? 6 : 4.5;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 地面武器拾取點：直接放置於地面（無光環、無文字），完全對應實戰武器原圖
 */
export function drawPickup(ctx: CanvasRenderingContext2D, pk: PickupItem) {
  ctx.save();
  ctx.translate(pk.x, pk.y);

  if (pk.kind === 'gun' && pk.gunDef) {
    ctx.rotate(-0.42);
    const gk = pk.gunDef.kind;
    if (gk === 'sniper') {
      // 木托深藍鋼管 + 放大鏡瞄準器
      ctx.fillStyle = '#B45309';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-18, 1);
      ctx.lineTo(-10, -1);
      ctx.lineTo(6, -1);
      ctx.lineTo(6, 3.5);
      ctx.lineTo(-6, 4);
      ctx.lineTo(-9, 9);
      ctx.lineTo(-12, 8);
      ctx.lineTo(-11, 4);
      ctx.lineTo(-16, 7.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#1E3A5F';
      ctx.fillRect(-2, -3.5, 22, 3.4);
      ctx.strokeRect(-2, -3.5, 22, 3.4);

      // 大型藍鋼狙擊鏡
      ctx.fillStyle = '#1E3A5F';
      ctx.fillRect(-7, -8.8, 14, 4.2);
      ctx.strokeRect(-7, -8.8, 14, 4.2);
      ctx.fillStyle = '#38BDF8';
      ctx.beginPath();
      ctx.arc(-6.8, -6.7, 2.1, 0, Math.PI * 2);
      ctx.arc(6.8, -6.7, 2.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (gk === 'shotgun') {
      // 紅木托＋橘棕護木＋深鋼槍管
      ctx.fillStyle = '#1E3A5F';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.7;
      ctx.fillRect(-4, -3.5, 22, 3.4);
      ctx.strokeRect(-4, -3.5, 22, 3.4);

      ctx.fillStyle = '#0F172A';
      ctx.fillRect(-8, -3.5, 11, 5.5);
      ctx.strokeRect(-8, -3.5, 11, 5.5);

      ctx.fillStyle = '#C2410C';
      ctx.fillRect(3, -0.5, 11, 4);
      ctx.strokeRect(3, -0.5, 11, 4);

      ctx.fillStyle = '#B45309';
      ctx.beginPath();
      ctx.moveTo(-18, 2);
      ctx.lineTo(-8, -2);
      ctx.lineTo(-7, 3);
      ctx.lineTo(-14, 8.5);
      ctx.lineTo(-18, 6.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (gk === 'rifle') {
      // 黑色 M4 步槍＋提把＋前準星＋彎彈匣
      ctx.fillStyle = '#0F172A';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(-18, -2.5);
      ctx.lineTo(-7, -2.5);
      ctx.lineTo(-7, 2);
      ctx.lineTo(-15, 5.5);
      ctx.lineTo(-18, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillRect(-7, -3, 19, 5.5);
      ctx.strokeRect(-7, -3, 19, 5.5);
      ctx.fillRect(12, -1.8, 8, 2.5);
      ctx.strokeRect(12, -1.8, 8, 2.5);
      ctx.beginPath();
      ctx.moveTo(-5, -3);
      ctx.lineTo(-3.5, -6.5);
      ctx.lineTo(3, -6.5);
      ctx.lineTo(4, -3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(13, -1.8);
      ctx.lineTo(14.5, -5.5);
      ctx.lineTo(16, -1.8);
      ctx.fill();
      ctx.fillStyle = '#1E293B';
      ctx.beginPath();
      ctx.moveTo(1, 2.5);
      ctx.lineTo(5, 2.5);
      ctx.lineTo(7, 11.5);
      ctx.lineTo(3, 12);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      // 深黑軍用小槍
      ctx.fillStyle = '#0F172A';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.8;
      ctx.fillRect(-9, -6, 20, 6);
      ctx.strokeRect(-9, -6, 20, 6);
      ctx.fillStyle = '#334155';
      ctx.fillRect(-8, -5, 17, 2.5);
      ctx.fillStyle = '#020617';
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-4, 9.5);
      ctx.lineTo(-10, 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  } else if (pk.kind === 'melee' && pk.meleeDef) {
    const mk = pk.meleeDef.kind;
    if (mk === 'shield') {
      // 放置於地面的戰術防彈盾（實心裝甲盾體＋觀察窗＋金屬鉚釘）
      ctx.rotate(-0.28);
      ctx.fillStyle = '#0F172A';
      ctx.strokeStyle = '#64748B';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.roundRect(-11, -14, 22, 28, 5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#1E293B';
      ctx.beginPath();
      ctx.roundRect(-8.5, -11.5, 17, 23, 3.5);
      ctx.fill();

      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(-7, -9.5, 14, 19);

      ctx.fillStyle = '#020617';
      ctx.fillRect(-5.5, -7, 11, 4.2);
      ctx.fillStyle = '#BAE6FD';
      ctx.fillRect(-4, -5.8, 8, 1.8);

      ctx.fillStyle = '#94A3B8';
      ctx.beginPath();
      ctx.arc(-4.5, 6.5, 1.3, 0, Math.PI * 2);
      ctx.arc(4.5, 6.5, 1.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (mk === 'claw') {
      // 地面雙爪並排（左右各一具深藍護腕＋三根彎曲銀爪）
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(side * 9, 4);
        ctx.fillStyle = '#1E3A8A';
        ctx.strokeStyle = '#020617';
        ctx.lineWidth = 1.7;
        ctx.fillRect(-6, 0, 12, 4.5);
        ctx.strokeRect(-6, 0, 12, 4.5);

        for (const bx of [-4, 0, 4]) {
          ctx.beginPath();
          ctx.moveTo(bx - 1.4, 0);
          ctx.quadraticCurveTo(bx - side * 1.5, -9, bx + side * 2.2, -16);
          ctx.quadraticCurveTo(bx + 1.5, -8, bx + 1.4, 0);
          ctx.closePath();
          ctx.fillStyle = '#E2E8F0';
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    } else if (mk === 'greatsword') {
      // 方案 A：經典光暈太刀（粗黑描邊＋微彎藍灰銀刃＋暖金鍔＋藍鋼菱格柄＋發光金球首）
      ctx.rotate(-0.42);
      // 弧形太刀刃（上背凹微彎、下刃凸亮銀切先）
      ctx.beginPath();
      ctx.moveTo(1, -2.0);
      ctx.quadraticCurveTo(15, -1.6, 30.5, -3.8);
      ctx.lineTo(26.5, 0.5);
      ctx.quadraticCurveTo(14, 2.8, 1, 2.2);
      ctx.closePath();
      ctx.fillStyle = '#F8FAFC';
      ctx.fill();
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 2.0;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // 刀背藍灰金屬漸層陰影
      const spineGrad = ctx.createLinearGradient(0, -2.8, 0, 0.4);
      spineGrad.addColorStop(0, '#334155');
      spineGrad.addColorStop(1, '#64748B');
      ctx.beginPath();
      ctx.moveTo(1.4, -1.8);
      ctx.quadraticCurveTo(15, -1.4, 29.3, -3.4);
      ctx.lineTo(27.8, -1.2);
      ctx.quadraticCurveTo(14.5, 0.4, 1.4, 0.1);
      ctx.closePath();
      ctx.fillStyle = spineGrad;
      ctx.fill();

      // 暖金鍔口＆緣金箍
      ctx.fillStyle = '#F59E0B';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.6;
      ctx.fillRect(-1.2, -2.2, 2.5, 4.4);
      ctx.strokeRect(-1.2, -2.2, 2.5, 4.4);

      ctx.fillStyle = '#EAB308';
      ctx.beginPath();
      ctx.roundRect(-4.2, -4.9, 3.2, 9.8, 1.2);
      ctx.fill();
      ctx.stroke();

      // 深藍鋼菱格刀柄＋突出圓金球首
      ctx.fillStyle = '#1E293B';
      ctx.beginPath();
      ctx.roundRect(-16.5, -2.1, 12.3, 4.2, 1.0);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#94A3B8';
      for (const dx of [-13.8, -10.3, -6.8]) {
        ctx.save();
        ctx.translate(dx, 0);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-1.1, -1.1, 2.2, 2.2);
        ctx.restore();
      }
      ctx.fillStyle = '#F59E0B';
      ctx.beginPath();
      ctx.arc(-19.2, 0, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#FDE68A';
      ctx.beginPath();
      ctx.arc(-19.7, -0.7, 1.1, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // 弧形黑脊亮銀刃戰術小刀
      ctx.rotate(-0.52);
      ctx.beginPath();
      ctx.moveTo(-1, -3);
      ctx.quadraticCurveTo(8, -3.5, 16, 0.5);
      ctx.quadraticCurveTo(8, 3.2, -1, 2.8);
      ctx.closePath();
      ctx.fillStyle = '#E2E8F0';
      ctx.fill();
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.fillStyle = '#1E293B';
      ctx.fillRect(-13, -2.5, 11, 5);
      ctx.strokeRect(-13, -2.5, 11, 5);
    }
  } else if (pk.kind === 'ammo') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 8, 16, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(0, Math.sin(pk.bobPhase) * 1.8);

    // Olive ammo case with a lid, latch and yellow identification stripe.
    ctx.strokeStyle = '#111909';
    ctx.lineWidth = 2;
    ctx.fillStyle = '#414D2B';
    ctx.beginPath();
    ctx.roundRect(-14, -6, 28, 17, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#68734A';
    ctx.beginPath();
    ctx.roundRect(-15, -10, 30, 9, 3);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#D6B853';
    ctx.fillRect(-10, 4, 20, 3);
    ctx.fillStyle = '#B2B8A0';
    ctx.fillRect(-3, -4, 6, 7);
    ctx.strokeRect(-3, -4, 6, 7);
  }

  ctx.restore();
}

function drawShieldFlow(ctx: CanvasRenderingContext2D, radius: number, time: number) {
  ctx.save();
  ctx.clip();
  const driftX = Math.cos(time * 0.9) * radius * 0.56;
  const driftY = Math.sin(time * 0.9) * radius * 0.39;
  const haze = ctx.createRadialGradient(driftX, driftY, 0, driftX, driftY, radius * 0.74);
  haze.addColorStop(0, 'rgba(116, 199, 211, 0.21)');
  haze.addColorStop(1, 'rgba(116, 199, 211, 0)');
  ctx.fillStyle = haze;
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);

  const tilt = 0.54 + Math.sin(time * 0.48) * 0.22;
  for (let i = 0; i < 7; i++) {
    const latitude = (i % 3 - 1) * 0.54;
    const band = radius * Math.cos(latitude) * 0.95;
    const height = radius * Math.sin(latitude) * 0.95;
    const longitude = time * (0.86 + i * 0.055) + i * 2.4;
    const depth = Math.sin(longitude);
    const opacity = (0.16 + 0.35 * (1 + depth) / 2) * (0.82 + 0.18 * Math.sin(time * 2 + i));
    const headX = Math.cos(longitude) * band;
    const headY = height * Math.cos(tilt) + depth * band * Math.sin(tilt);
    ctx.lineCap = 'round';
    for (let j = 3; j >= 0; j--) {
      const start = longitude - (j + 1) * 0.17;
      const end = longitude - j * 0.17;
      ctx.beginPath();
      ctx.moveTo(Math.cos(start) * band, height * Math.cos(tilt) + Math.sin(start) * band * Math.sin(tilt));
      ctx.lineTo(Math.cos(end) * band, height * Math.cos(tilt) + Math.sin(end) * band * Math.sin(tilt));
      ctx.strokeStyle = `rgba(169, 222, 233, ${opacity * (1 - j * 0.23)})`;
      ctx.lineWidth = 0.9 + (1 + depth) * 0.43;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(headX, headY, 1 + depth * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(215, 245, 246, ${opacity})`;
    ctx.fill();
  }
  ctx.restore();
}

export function drawRoyalShield(
  ctx: CanvasRenderingContext2D,
  actor: { x: number; y: number; radius: number; royalShieldImpact?: { angle: number; time: number } },
  time: number
) {
  const radius = actor.radius + ROYAL_SHIELD_PADDING;
  const glint = 0.47 + Math.sin(time * 0.8) * 0.04;
  ctx.save();
  ctx.translate(actor.x, actor.y);

  const shell = ctx.createRadialGradient(0, 0, radius * 0.54, 0, 0, radius);
  shell.addColorStop(0, 'rgba(26, 52, 67, 0.025)');
  shell.addColorStop(0.72, 'rgba(56, 122, 142, 0.08)');
  shell.addColorStop(1, 'rgba(134, 191, 205, 0.27)');
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = shell;
  ctx.fill();

  const edge = ctx.createLinearGradient(-radius * 0.7, -radius, radius * 0.6, radius);
  edge.addColorStop(0, `rgba(212, 233, 238, ${glint})`);
  edge.addColorStop(0.52, 'rgba(127, 180, 198, 0.29)');
  edge.addColorStop(1, 'rgba(49, 92, 117, 0.56)');
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.35;
  ctx.stroke();

  const reflection = ctx.createRadialGradient(-radius * 0.42, -radius * 0.55, 0, -radius * 0.42, -radius * 0.55, radius * 0.55);
  reflection.addColorStop(0, 'rgba(236, 249, 250, 0.17)');
  reflection.addColorStop(1, 'rgba(236, 249, 250, 0)');
  ctx.fillStyle = reflection;
  ctx.fill();
  drawShieldFlow(ctx, radius, time);

  const impact = actor.royalShieldImpact;
  if (impact) {
    const age = time - impact.time;
    const progress = age / 0.32;
    if (progress >= 0 && progress < 1) {
      const arc = 0.18 + progress * 1.2;
      ctx.globalAlpha *= (1 - progress) * 0.72;
      ctx.strokeStyle = '#D7F9FF';
      ctx.lineWidth = 1.8 - progress * 0.65;
      for (const offset of [0, 4]) {
        ctx.beginPath();
        ctx.arc(0, 0, radius + offset + progress * 5, impact.angle - arc, impact.angle + arc);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

export function drawQiRecovery(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, time: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#8AC5EA';
  for (let i = 0; i < 3; i++) {
    const phase = (time * 0.68 + i / 3) % 1;
    const angle = i * Math.PI * 2 / 3 + time * 0.25;
    const distance = radius * (1.05 - phase * 0.52) + (1 - phase) * 11;
    ctx.globalAlpha = Math.sin(Math.PI * phase) * 0.43;
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, 1.5 - phase * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function getFactionChargeColor(faction: 'royal' | 'shadow' | 'mercenary'): { rgb: string; hex: string } {
  if (faction === 'royal') return { rgb: '56, 189, 248', hex: '#38BDF8' };
  if (faction === 'shadow') return { rgb: '251, 113, 133', hex: '#FB7185' };
  return { rgb: '251, 191, 36', hex: '#FBBF24' };
}

export function drawMeleeChargeAura(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  time: number,
  faction: 'royal' | 'shadow' | 'mercenary',
  chargeReady: boolean,
  chargeProgress = 1
) {
  const accent = getFactionChargeColor(faction);
  ctx.save();
  ctx.translate(x, y);

  if (chargeReady) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 8.5);
    const outerR = radius * (1.72 + pulse * 0.22);
    const halo = ctx.createRadialGradient(0, 0, radius * 0.72, 0, 0, outerR);
    halo.addColorStop(0, 'rgba(254, 249, 195, 0.42)');
    halo.addColorStop(0.45, `rgba(${accent.rgb}, ${0.32 + pulse * 0.14})`);
    halo.addColorStop(1, 'rgba(251, 191, 36, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, outerR, 0, Math.PI * 2);
    ctx.fill();

    // Two staggered expanding shockwave rings so nearby players spot full charge immediately
    for (const offset of [0, 0.5]) {
      const phase = (time * 1.55 + offset) % 1;
      const ringR = radius * (1.05 + phase * 1.1);
      ctx.globalAlpha = (1 - phase) * 0.85;
      ctx.strokeStyle = offset === 0 ? '#FEF08A' : accent.hex;
      ctx.lineWidth = 2.6 - phase * 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.8 + pulse * 0.2;
    ctx.strokeStyle = '#FDE047';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.18, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const p = clamp(chargeProgress, 0, 1);
    const ringR = radius * (1.42 - p * 0.26);
    ctx.globalAlpha = 0.24 + p * 0.42;
    ctx.strokeStyle = accent.hex;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(0, 0, ringR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#FEF08A';
    for (let i = 0; i < 4; i++) {
      const orbPhase = (time * 1.15 + i * 0.25) % 1;
      const orbDist = radius * (1.8 - orbPhase * 0.78);
      const ang = i * (Math.PI / 2) + time * 2.2;
      ctx.globalAlpha = Math.sin(Math.PI * orbPhase) * (0.35 + p * 0.45);
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * orbDist, Math.sin(ang) * orbDist, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

export function drawMeleeChargeSparks(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  time: number,
  faction: 'royal' | 'shadow' | 'mercenary'
) {
  const accent = getFactionChargeColor(faction);
  ctx.save();
  ctx.translate(x, y);

  for (let i = 0; i < 8; i++) {
    const baseAngle = (i / 8) * Math.PI * 2 + time * 3.1;
    const liftPhase = (time * 1.8 + i * 0.125) % 1;
    const orbitDist = radius * (1.04 + Math.sin(time * 5 + i) * 0.16);
    const sx = Math.cos(baseAngle) * orbitDist;
    const sy = Math.sin(baseAngle) * orbitDist * 0.88 - liftPhase * 8;
    const sparkAlpha = 0.55 + 0.45 * Math.sin(time * 10 + i * 1.3);
    const isAlt = i % 2 === 1;

    ctx.globalAlpha = sparkAlpha;
    ctx.fillStyle = isAlt ? accent.hex : '#FEF9C3';
    ctx.beginPath();
    ctx.arc(sx, sy, isAlt ? 2.8 : 2.3, 0, Math.PI * 2);
    ctx.fill();

    if (i % 2 === 0) {
      const arm = 5.2 + Math.sin(time * 9 + i) * 1.4;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.moveTo(sx - arm, sy);
      ctx.lineTo(sx + arm, sy);
      ctx.moveTo(sx, sy - arm);
      ctx.lineTo(sx, sy + arm);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawEagleEyeVisor(ctx: CanvasRenderingContext2D, radius: number, remaining: number) {
  const activation = clamp((EAGLE_EYE_DURATION - remaining) / 0.48, 0, 1);
  const fade = Math.min(1, remaining / 0.45);
  const halfSpan = radius * 0.58;
  const front = radius * 0.66;
  ctx.save();
  ctx.globalAlpha *= fade;

  ctx.beginPath();
  ctx.moveTo(radius * 0.34, -halfSpan);
  ctx.quadraticCurveTo(front, -halfSpan * 0.8, front, 0);
  ctx.quadraticCurveTo(front, halfSpan * 0.8, radius * 0.34, halfSpan);
  ctx.quadraticCurveTo(radius * 0.49, 0, radius * 0.34, -halfSpan);
  ctx.closePath();
  const glass = ctx.createLinearGradient(radius * 0.34, 0, front, 0);
  glass.addColorStop(0, 'rgba(20, 11, 22, 0.95)');
  glass.addColorStop(0.58, 'rgba(86, 35, 56, 0.93)');
  glass.addColorStop(1, 'rgba(176, 91, 109, 0.91)');
  ctx.fillStyle = glass;
  ctx.fill();

  const edge = ctx.createLinearGradient(0, -halfSpan, 0, halfSpan);
  edge.addColorStop(0, 'rgba(128, 65, 83, 0.22)');
  edge.addColorStop(0.38, 'rgba(230, 158, 167, 0.88)');
  edge.addColorStop(0.65, 'rgba(167, 84, 104, 0.70)');
  edge.addColorStop(1, 'rgba(57, 28, 42, 0.36)');
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = edge;
  ctx.stroke();

  if (activation < 1) {
    const scanY = halfSpan * (2 * (1 - (1 - activation) ** 2) - 1);
    ctx.save();
    ctx.clip();
    const glint = ctx.createLinearGradient(0, scanY - 3, 0, scanY + 3);
    glint.addColorStop(0, 'rgba(245, 197, 192, 0)');
    glint.addColorStop(0.5, 'rgba(245, 197, 192, 0.52)');
    glint.addColorStop(1, 'rgba(245, 197, 192, 0)');
    ctx.fillStyle = glint;
    ctx.fillRect(radius * 0.30, scanY - 3, radius * 0.40, 6);
    ctx.restore();
  }
  ctx.restore();
}

export function drawCharacter(ctx: CanvasRenderingContext2D, params: CharacterRenderParams) {
  const {
    x,
    y,
    radius,
    angle,
    bodyColor,
    role,
    holdingMelee,
    shadowActive,
    time,
    isReloading = false,
    reloadProgress = 0,
    isBlinded = false,
    isFrozen = false,
    gunKind = 'pistol',
    meleeKind = 'knife',
    skin,
    walkPhase = 0,
    moveIntensity = 0,
    swapProgress = 0,
    attackAnimProgress = 0,
    attackAnimKind = null,
    gunfireTimer = 0,
    eagleEyeRemaining = 0,
    shadowDodge,
    morphScale = 1,
  } = params;

  const dodge = shadowDodge ? clamp((time - shadowDodge.startedAt) / 0.31, 0, 1) : 1;
  const lean = dodge < 1 ? Math.sin(Math.PI * dodge ** 0.64) * radius * 1.06 : 0;
  const dodgeAngle = shadowDodge?.angle ?? angle;
  if (shadowActive || lean > 0) {
    drawShadowForms(ctx, x, y, radius, angle, time, lean, dodgeAngle);
  }

  ctx.save();
  ctx.translate(x + Math.cos(dodgeAngle) * lean, y + Math.sin(dodgeAngle) * lean);

  // 地面投影
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.beginPath();
  ctx.ellipse(2, 4, radius * 0.84, radius * 0.78, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.rotate(angle);
  ctx.scale(1 - (morphScale - 1) * 0.22, 1 + (morphScale - 1) * 0.46);

  const bodyR = radius * 0.72;
  const stride = Math.sin(walkPhase) * radius * 0.4 * moveIntensity;
  const armSwing = Math.sin(walkPhase) * radius * 0.22 * moveIntensity;
  const handR = Math.max(4.4, radius * 0.25);
  const handColor = skin?.handColor || '#FECACA';
  const isHitWhite = bodyColor.toUpperCase() === '#FFFFFF';

  // 1. 雙腳（行走時前後交替擺動）
  for (const side of [-1, 1]) {
    const footX = radius * 0.14 + (side === -1 ? stride : -stride);
    const footY = side * radius * 0.34;
    ctx.save();
    ctx.translate(footX, footY);
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 0.28, radius * 0.17, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#1E293B';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#020617';
    ctx.stroke();
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.ellipse(radius * 0.08, 0, radius * 0.09, radius * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Giant form spreads its weight across a wider shoulder silhouette.
  if (morphScale > 1.02) {
    ctx.save();
    ctx.globalAlpha *= clamp((morphScale - 1) * 4, 0, 1);
    for (const side of [-1, 1]) {
      const shoulder = ctx.createLinearGradient(-bodyR, 0, bodyR * 0.48, 0);
      shoulder.addColorStop(0, '#27282C');
      shoulder.addColorStop(0.56, bodyColor);
      shoulder.addColorStop(1, '#857B72');
      ctx.beginPath();
      ctx.moveTo(-bodyR * 0.69, side * bodyR * 0.61);
      ctx.quadraticCurveTo(-bodyR * 0.84, side * bodyR * 1.13, -bodyR * 0.4, side * bodyR * 1.27);
      ctx.quadraticCurveTo(bodyR * 0.12, side * bodyR * 1.17, bodyR * 0.38, side * bodyR * 0.76);
      ctx.lineTo(0, side * bodyR * 0.47);
      ctx.closePath();
      ctx.fillStyle = shoulder;
      ctx.fill();
      ctx.strokeStyle = '#262428';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2. 後腦飾物（依三大陣營實戰角色原圖繪製）
  if (skin && !isHitWhite) {
    ctx.save();
    ctx.lineJoin = 'round';
    if (skin.hairOrCrest === 'spiky_crest') {
      ctx.beginPath();
      ctx.moveTo(bodyR * 0.1, -bodyR * 0.92);
      ctx.lineTo(-bodyR * 0.95, -bodyR * 1.05);
      ctx.lineTo(-bodyR * 0.65, -bodyR * 0.55);
      ctx.lineTo(-bodyR * 1.32, -bodyR * 0.35);
      ctx.lineTo(-bodyR * 0.8, 0);
      ctx.lineTo(-bodyR * 1.32, bodyR * 0.35);
      ctx.lineTo(-bodyR * 0.65, bodyR * 0.55);
      ctx.lineTo(-bodyR * 0.95, bodyR * 1.05);
      ctx.lineTo(bodyR * 0.1, bodyR * 0.92);
      ctx.closePath();
      ctx.fillStyle = skin.hairColor;
      ctx.fill();
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'twintail_bow') {
      const tailWag = Math.sin(walkPhase) * radius * 0.1 * moveIntensity;
      ctx.beginPath();
      ctx.moveTo(-bodyR * 0.55, -bodyR * 0.15);
      ctx.quadraticCurveTo(-bodyR * 1.05, -bodyR * 0.45 + tailWag, -bodyR * 1.42, tailWag);
      ctx.quadraticCurveTo(-bodyR * 1.05, bodyR * 0.4 + tailWag, -bodyR * 0.55, bodyR * 0.22);
      ctx.closePath();
      ctx.fillStyle = skin.hairColor;
      ctx.fill();
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = '#020617';
      ctx.stroke();

      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(bodyR * 0.05, side * bodyR * 0.78);
        ctx.lineTo(bodyR * 0.38, side * bodyR * 1.06);
        ctx.lineTo(bodyR * 0.48, side * bodyR * 0.72);
        ctx.closePath();
        ctx.fillStyle = skin.trimColor;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#020617';
        ctx.stroke();
      }
    } else if (skin.hairOrCrest === 'horned_mask') {
      ctx.beginPath();
      ctx.moveTo(-bodyR * 0.35, bodyR * 0.5);
      ctx.quadraticCurveTo(-bodyR * 0.95, bodyR * 0.9, -bodyR * 1.32, bodyR * 0.65);
      ctx.lineTo(-bodyR * 0.92, bodyR * 0.3);
      ctx.lineTo(-bodyR * 1.25, bodyR * 0.12);
      ctx.lineTo(-bodyR * 0.45, bodyR * 0.1);
      ctx.closePath();
      ctx.fillStyle = skin.hairColor;
      ctx.fill();
      ctx.lineWidth = 1.9;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'cyber_visor') {
      ctx.save();
      ctx.translate(-bodyR * 0.75, -bodyR * 0.72);
      ctx.rotate(-0.24);
      ctx.fillStyle = skin.hairColor;
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.8;
      ctx.fillRect(-bodyR * 0.45, -2, bodyR * 0.75, 4);
      ctx.strokeRect(-bodyR * 0.45, -2, bodyR * 0.75, 4);
      ctx.restore();
      for (const side of [-1, 1]) {
        ctx.fillStyle = skin.hairColor;
        ctx.strokeStyle = '#020617';
        ctx.lineWidth = 1.6;
        ctx.fillRect(-bodyR * 0.25, side * bodyR * 0.82 - 2, bodyR * 0.45, 4);
        ctx.strokeRect(-bodyR * 0.25, side * bodyR * 0.82 - 2, bodyR * 0.45, 4);
      }
    } else if (skin.hairOrCrest === 'royal_wing_crown') {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(-bodyR * 0.45, side * bodyR * 0.55);
        ctx.lineTo(-bodyR * 1.35, side * bodyR * 1.0);
        ctx.lineTo(-bodyR * 0.9, side * bodyR * 0.35);
        ctx.closePath();
        ctx.fillStyle = skin.hairColor;
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = '#020617';
        ctx.stroke();
      }
    } else if (skin.hairOrCrest === 'royal_ears_band') {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(-bodyR * 0.4, side * bodyR * 0.62);
        ctx.lineTo(-bodyR * 1.25, side * bodyR * 1.08);
        ctx.lineTo(-bodyR * 0.8, side * bodyR * 0.35);
        ctx.closePath();
        ctx.fillStyle = skin.hairColor;
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = skin.trimColor;
        ctx.stroke();
      }
    } else if (skin.hairOrCrest === 'royal_v_knight') {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(-bodyR * 0.75, side * bodyR * 0.35);
        ctx.lineTo(-bodyR * 1.45, side * bodyR * 0.55);
        ctx.lineTo(-bodyR * 1.0, side * bodyR * 0.12);
        ctx.closePath();
        ctx.fillStyle = '#38BDF8';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#020617';
        ctx.stroke();
      }
    } else if (skin.hairOrCrest === 'merc_cloak_goggles') {
      ctx.beginPath();
      ctx.moveTo(-bodyR * 0.3, -bodyR * 0.95);
      ctx.quadraticCurveTo(-bodyR * 1.15, -bodyR * 1.15, -bodyR * 1.4, -bodyR * 0.75);
      ctx.lineTo(-bodyR * 1.05, -bodyR * 0.18);
      ctx.lineTo(-bodyR * 1.4, bodyR * 0.65);
      ctx.quadraticCurveTo(-bodyR * 1.15, bodyR * 1.15, -bodyR * 0.3, bodyR * 0.95);
      ctx.closePath();
      ctx.fillStyle = skin.hairColor;
      ctx.fill();
      ctx.lineWidth = 1.9;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'merc_ponytail_goggles') {
      ctx.fillStyle = '#C2410C';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.6;
      ctx.fillRect(-bodyR * 1.42, -bodyR * 0.88, bodyR * 0.9, 3.6);
      ctx.strokeRect(-bodyR * 1.42, -bodyR * 0.88, bodyR * 0.9, 3.6);

      const tailWag = Math.sin(walkPhase) * radius * 0.1 * moveIntensity;
      ctx.beginPath();
      ctx.moveTo(-bodyR * 0.55, -bodyR * 0.12);
      ctx.quadraticCurveTo(-bodyR * 1.05, -bodyR * 0.45 + tailWag, -bodyR * 1.45, tailWag);
      ctx.quadraticCurveTo(-bodyR * 1.05, bodyR * 0.35 + tailWag, -bodyR * 0.55, bodyR * 0.2);
      ctx.closePath();
      ctx.fillStyle = skin.hairColor;
      ctx.fill();
      ctx.stroke();
    } else if (skin.hairOrCrest === 'merc_spiky_goggles') {
      ctx.beginPath();
      ctx.moveTo(0, -bodyR * 0.95);
      ctx.quadraticCurveTo(-bodyR * 0.85, -bodyR * 1.15, -bodyR * 1.32, -bodyR * 0.55);
      ctx.lineTo(-bodyR * 0.92, -bodyR * 0.32);
      ctx.lineTo(-bodyR * 1.38, bodyR * 0.18);
      ctx.lineTo(-bodyR * 0.95, bodyR * 0.38);
      ctx.quadraticCurveTo(-bodyR * 1.15, bodyR * 0.82, -bodyR * 0.45, bodyR * 0.95);
      ctx.lineTo(0, bodyR * 0.85);
      ctx.closePath();
      ctx.fillStyle = skin.bodyHighlight;
      ctx.fill();
      ctx.lineWidth = 1.9;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'merc_gem_band') {
      ctx.beginPath();
      ctx.moveTo(-bodyR * 0.15, -bodyR * 0.95);
      ctx.lineTo(-bodyR * 1.15, -bodyR * 0.72);
      ctx.lineTo(-bodyR * 0.9, -bodyR * 0.32);
      ctx.lineTo(-bodyR * 1.25, 0);
      ctx.lineTo(-bodyR * 0.9, bodyR * 0.32);
      ctx.lineTo(-bodyR * 1.15, bodyR * 0.72);
      ctx.lineTo(-bodyR * 0.15, bodyR * 0.95);
      ctx.closePath();
      ctx.fillStyle = skin.bodyColor;
      ctx.fill();
      ctx.lineWidth = 1.9;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3. 武器及持握姿勢
  const drawGrip = (x: number, y: number, side: -1 | 1) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(bodyR * 0.18, side * bodyR * 0.70);
    ctx.quadraticCurveTo(bodyR * 0.83, side * bodyR * 0.91, x, y);
    ctx.lineCap = 'round';
    ctx.lineWidth = handR * 1.58;
    ctx.strokeStyle = '#020617';
    ctx.stroke();
    ctx.lineWidth = handR * 1.03;
    ctx.strokeStyle = skin?.bodyHighlight || bodyColor;
    ctx.stroke();
    ctx.restore();
    drawHand(ctx, x, y, handR, handColor);
  };
  if (swapProgress > 0) {
    // 換手時雙手平順合攏再分開
    const reach = Math.sin(swapProgress * Math.PI);
    const handX = bodyR * 1.11;
    const separation = 6 - reach * 2.5;
    drawGrip(handX - reach * 2, -separation, -1);
    drawGrip(handX + reach * 2, separation, 1);
  } else if (isReloading && !holdingMelee) {
    const tilt = -0.82 + Math.sin(reloadProgress * Math.PI) * 0.06;
    const gunLen = gunKind === 'sniper' ? 32 : gunKind === 'rifle' ? 28 : gunKind === 'shotgun' ? 27 : 19;
    const magPhase =
      reloadProgress < 0.4
        ? reloadProgress / 0.4
        : reloadProgress < 0.75
          ? 1 - (reloadProgress - 0.4) / 0.35
          : 0;
    const rackPhase = reloadProgress >= 0.75 ? Math.sin(((reloadProgress - 0.75) / 0.25) * Math.PI) : 0;

    ctx.save();
    ctx.rotate(tilt);
    ctx.translate(bodyR * 0.32, 0);

    ctx.fillStyle = gunKind === 'sniper' || gunKind === 'shotgun' ? '#B45309' : '#0F172A';
    ctx.strokeStyle = '#020617';
    ctx.lineWidth = 1.6;
    ctx.fillRect(bodyR * 0.52, -3.2, gunLen, 6.4);
    ctx.strokeRect(bodyR * 0.52, -3.2, gunLen, 6.4);
    ctx.fillStyle = gunKind === 'sniper' || gunKind === 'shotgun' ? '#1E3A5F' : '#334155';
    ctx.fillRect(bodyR * 0.52 + 8, -2.2, gunLen - 8, 4.4);
    if (gunKind === 'sniper') {
      ctx.fillStyle = '#38BDF8';
      ctx.fillRect(bodyR * 0.52 + 6, -5, 10, 2.5);
    }

    const magOffsetY = 4 + magPhase * 12;
    const magX = bodyR * 0.78 + (gunKind === 'sniper' ? 4 : 2);
    ctx.fillStyle = gunKind === 'shotgun' ? '#C2410C' : '#FBBF24';
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 1.2;
    ctx.fillRect(magX, magOffsetY, gunKind === 'rifle' ? 6 : 5, gunKind === 'shotgun' ? 8 : 9);
    ctx.strokeRect(magX, magOffsetY, gunKind === 'rifle' ? 6 : 5, gunKind === 'shotgun' ? 8 : 9);

    const leftHandX = reloadProgress >= 0.75 ? bodyR * 0.78 - rackPhase * 7 : magX + 2.5;
    const leftHandY = reloadProgress >= 0.75 ? -5 : magOffsetY + 4;
    drawGrip(leftHandX, leftHandY, 1);
    drawGrip(bodyR * 0.62, -bodyR * 0.55, -1);
    ctx.restore();
  } else if (holdingMelee) {
    if (meleeKind === 'claw') {
      const lunge = attackAnimKind === 'claw' && attackAnimProgress > 0 ? Math.sin(attackAnimProgress * Math.PI) : 0;
      const rx = bodyR * 1.01 + armSwing * 0.72 + lunge * 14;
      const ry = bodyR * 0.78 - lunge * 6;
      const lx = bodyR * 1.01 - armSwing * 0.72 + lunge * 14;
      const ly = -bodyR * 0.78 + lunge * 6;

      for (const [hx, hy, dir] of [
        [rx, ry, -1],
        [lx, ly, 1],
      ] as const) {
        ctx.fillStyle = '#1E3A8A';
        ctx.strokeStyle = '#020617';
        ctx.lineWidth = 1.4;
        ctx.fillRect(hx - 4, hy - 5, 8, 10);
        ctx.strokeRect(hx - 4, hy - 5, 8, 10);
        for (const oy of [-3.5, 0, 3.5]) {
          ctx.beginPath();
          ctx.moveTo(hx + 2, hy + oy - 1);
          ctx.quadraticCurveTo(hx + 11, hy + oy + dir * 2, hx + 16, hy + oy + dir * 3.5);
          ctx.quadraticCurveTo(hx + 9, hy + oy + 1.4, hx + 2, hy + oy + 1.2);
          ctx.closePath();
          ctx.fillStyle = '#E2E8F0';
          ctx.fill();
          ctx.stroke();
        }
      }
      drawGrip(rx, ry, 1);
      drawGrip(lx, ly, -1);
    } else if (meleeKind === 'shield') {
      // 手持戰術防彈盾：置於身前正弧方向（左鍵推擊時雙手同步前頂）
      const bashLunge = attackAnimKind === 'shield' && attackAnimProgress > 0 ? Math.sin(attackAnimProgress * Math.PI) : 0;
      const gripX = bodyR * 1.34 + bashLunge * 7;
      drawGrip(gripX, -bodyR * 0.57, -1);
      drawGrip(gripX, bodyR * 0.57, 1);

      const shieldFrontX = bodyR * 1.65 + bashLunge * 8;
      const halfSpan = bodyR * 1.12;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(shieldFrontX - 4, -halfSpan);
      ctx.quadraticCurveTo(shieldFrontX + 5.5, 0, shieldFrontX - 4, halfSpan);
      ctx.lineTo(shieldFrontX - 9, halfSpan * 0.92);
      ctx.quadraticCurveTo(shieldFrontX + 0.5, 0, shieldFrontX - 9, -halfSpan * 0.92);
      ctx.closePath();
      ctx.fillStyle = '#1E293B';
      ctx.fill();
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 2.0;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(shieldFrontX - 4.2, -halfSpan * 0.92);
      ctx.quadraticCurveTo(shieldFrontX + 4.8, 0, shieldFrontX - 4.2, halfSpan * 0.92);
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 2.2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(shieldFrontX - 5.2, -halfSpan * 0.65);
      ctx.quadraticCurveTo(shieldFrontX + 3.2, 0, shieldFrontX - 5.2, halfSpan * 0.65);
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.6;
      ctx.stroke();

      ctx.fillStyle = '#BAE6FD';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.2;
      ctx.fillRect(shieldFrontX - 2.2, -4.5, 3.6, 9);
      ctx.strokeRect(shieldFrontX - 2.2, -4.5, 3.6, 9);
      ctx.restore();
    } else if (meleeKind === 'greatsword') {
      const drawKatana = (tsubaX: number, isSwinging: boolean) => {
        // 發光圓形金色球首（柄頭）
        const pommelX = tsubaX - 20.5;
        ctx.save();
        ctx.fillStyle = 'rgba(251, 191, 36, 0.35)';
        ctx.beginPath();
        ctx.arc(pommelX, 0, 5.0, 0, Math.PI * 2);
        ctx.fill();

        const pommelGrad = ctx.createRadialGradient(pommelX - 1.1, -1.1, 0.5, pommelX, 0, 3.9);
        pommelGrad.addColorStop(0, '#FEF3C7');
        pommelGrad.addColorStop(0.5, '#F59E0B');
        pommelGrad.addColorStop(1, '#B45309');
        ctx.fillStyle = pommelGrad;
        ctx.strokeStyle = '#020617';
        ctx.lineWidth = 1.9;
        ctx.beginPath();
        ctx.arc(pommelX, 0, 3.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#F59E0B';
        ctx.strokeStyle = '#78350F';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(pommelX, 0, 1.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#FEF9C3';
        ctx.beginPath();
        ctx.arc(pommelX - 0.7, -0.7, 0.65, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 藍鋼菱格編織刀柄 + 金色緣口
        ctx.fillStyle = '#1E293B';
        ctx.strokeStyle = '#020617';
        ctx.lineWidth = 1.9;
        ctx.beginPath();
        ctx.roundRect(tsubaX - 17, -2.6, 17, 5.2, 1.2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#94A3B8';
        for (const ox of [-14.5, -10.5, -6.5]) {
          ctx.save();
          ctx.translate(tsubaX + ox, 0);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-1.3, -1.3, 2.6, 2.6);
          ctx.restore();
        }
        ctx.fillStyle = '#EAB308';
        ctx.fillRect(tsubaX - 2.3, -2.3, 2.3, 4.6);

        // 緊湊暖金護手鍔 + 黃金鎺口
        const tsubaGrad = ctx.createLinearGradient(0, -5.8, 0, 5.8);
        tsubaGrad.addColorStop(0, '#FDE68A');
        tsubaGrad.addColorStop(0.5, '#EAB308');
        tsubaGrad.addColorStop(1, '#B45309');
        ctx.fillStyle = tsubaGrad;
        ctx.strokeStyle = '#020617';
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.roundRect(tsubaX, -5.8, 3.6, 11.6, 1.3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#F59E0B';
        ctx.lineWidth = 1.6;
        ctx.fillRect(tsubaX + 3.4, -2.8, 3.4, 5.6);
        ctx.strokeRect(tsubaX + 3.4, -2.8, 3.4, 5.6);

        // 方案 A：粗黑描邊微彎寬幅太刀刃（凹背於 -Y，雪亮凸刃於 +Y 領銜順時針橫斬）
        const bladeStartX = tsubaX + 6.4;
        const bladeTipX = tsubaX + 57.5;
        ctx.beginPath();
        ctx.moveTo(bladeStartX, -2.7);
        ctx.quadraticCurveTo(bladeStartX + 27, -2.0, bladeTipX, -4.6);
        ctx.lineTo(bladeTipX - 6.2, 0.6);
        ctx.quadraticCurveTo(bladeStartX + 28, 3.8, bladeStartX, 2.9);
        ctx.closePath();
        ctx.fillStyle = isSwinging ? '#FFFFFF' : '#F8FAFC';
        ctx.fill();
        ctx.strokeStyle = '#020617';
        ctx.lineWidth = 2.1;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // 藍灰金屬漸層刀背（沿 -Y 上半刃面延伸至切先）
        const spineGrad = ctx.createLinearGradient(0, -3.5, 0, 0.5);
        spineGrad.addColorStop(0, '#334155');
        spineGrad.addColorStop(1, '#64748B');
        ctx.beginPath();
        ctx.moveTo(bladeStartX + 0.6, -2.4);
        ctx.quadraticCurveTo(bladeStartX + 27, -1.7, bladeTipX - 1.5, -4.1);
        ctx.lineTo(bladeTipX - 4.0, -1.6);
        ctx.quadraticCurveTo(bladeStartX + 27, 0.5, bladeStartX + 0.6, 0.2);
        ctx.closePath();
        ctx.fillStyle = spineGrad;
        ctx.fill();

        // 刀尖銀白反光紋
        ctx.beginPath();
        ctx.moveTo(bladeTipX - 18, -0.6);
        ctx.quadraticCurveTo(bladeTipX - 9, 0.4, bladeTipX - 4.2, -1.2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.1;
        ctx.stroke();
      };

      if (attackAnimKind === 'greatsword' && attackAnimProgress > 0) {
        // 大刀由左至右順時針橫斬：由左側蓄勢（-1.75）快速橫掃過正前方（0）再收刀到右側（+1.55）
        const eased = 1 - Math.pow(1 - attackAnimProgress, 1.45);
        const swingRot = -1.75 + eased * 3.30;
        const swingTsubaX = bodyR * 1.46;
        ctx.save();
        ctx.rotate(swingRot);
        drawKatana(swingTsubaX, true);
        // 雙手整齊握於鍔後方深藍刀柄，不越過護手
        drawGrip(swingTsubaX - 13.5, 1.4, 1);
        drawGrip(swingTsubaX - 5.5, -1.2, -1);
        ctx.restore();
      } else {
        // 待機姿勢（刀背左肩）：雙手喺前左方緊握刀柄，金色球首朝前突出，刀身向後架於左肩外側
        const anchorX = bodyR * 0.14 + armSwing * 0.08;
        const anchorY = -bodyR * 1.06;
        const idleRot = -Math.PI + 0.24 + armSwing * 0.015;
        ctx.save();
        ctx.translate(anchorX, anchorY);
        ctx.rotate(idleRot);
        drawKatana(0, false);
        ctx.restore();

        const cosR = Math.cos(idleRot);
        const sinR = Math.sin(idleRot);
        const h1x = anchorX + -5.5 * cosR;
        const h1y = anchorY + -5.5 * sinR;
        const h2x = anchorX + -12.5 * cosR;
        const h2y = anchorY + -12.5 * sinR;
        drawGrip(h1x, h1y, -1);
        drawHand(ctx, h2x, h2y, handR * 0.96, handColor);
      }
    } else {
      // 小刀：刺擊時右手筆直前刺、左手後收保持平衡
      const thrust = attackAnimKind === 'knife' && attackAnimProgress > 0 ? Math.sin(attackAnimProgress * Math.PI) : 0;
      const rx = bodyR * 1.05 + armSwing * 0.55 + thrust * 16;
      const ry = bodyR * 0.74 - thrust * bodyR * 0.42;
      const lx = bodyR * 0.83 - armSwing * 0.85 - thrust * 6;
      const ly = -bodyR * 0.78;

      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(-0.55 * (1 - thrust * 0.88));
      ctx.beginPath();
      ctx.moveTo(0, -2.6);
      ctx.quadraticCurveTo(8, -3.4, 15.5, 0.2);
      ctx.quadraticCurveTo(8, 2.8, 0, 2.2);
      ctx.closePath();
      ctx.fillStyle = '#E2E8F0';
      ctx.fill();
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = '#1E293B';
      ctx.fillRect(-5, -2, 6, 4);
      ctx.restore();

      drawGrip(rx, ry, 1);
      drawGrip(lx, ly, -1);
    }
  } else {
    const recoil = (gunfireTimer / GUNFIRE_ANIMATION_SECONDS) ** 2;
    const flash = Math.max(0, (gunfireTimer - 0.072) / (GUNFIRE_ANIMATION_SECONDS - 0.072));
    ctx.save();
    ctx.translate(-recoil * (gunKind === 'pistol' ? 6 : 8), 0);
    if (gunKind === 'pistol') {
      const rx = bodyR * 1.19 + armSwing * 0.2;
      const ry = bodyR * 0.24;
      const lx = rx + handR * 0.7;
      const ly = ry - handR * 0.88;

      ctx.fillStyle = '#0F172A';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.5;
      ctx.fillRect(rx - 2, ry - 3, 20, 6);
      ctx.strokeRect(rx - 2, ry - 3, 20, 6);
      ctx.fillStyle = '#334155';
      ctx.fillRect(rx + 1, ry - 1.8, 15, 3.2);

      drawGrip(rx, ry, 1);
      drawGrip(lx, ly, -1);
      drawMuzzleFlash(ctx, rx + 18, ry, flash);
    } else {
      const baseGunX = bodyR * 0.91;
      const rx = baseGunX + 3;
      const ry = handR * 0.55;
      const lx = baseGunX + (gunKind === 'sniper' ? 16 : 12) + armSwing * 0.18;
      const ly = -handR * 0.53;

      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.5;
      if (gunKind === 'sniper') {
        ctx.fillStyle = '#B45309';
        ctx.fillRect(baseGunX - 2, -3.2, 16, 6.4);
        ctx.strokeRect(baseGunX - 2, -3.2, 16, 6.4);
        ctx.fillStyle = '#1E3A5F';
        ctx.fillRect(baseGunX + 10, -2.2, 25, 4.4);
        ctx.strokeRect(baseGunX + 10, -2.2, 25, 4.4);
        ctx.fillStyle = '#1E3A5F';
        ctx.fillRect(baseGunX + 3, -3.8, 13, 5.2);
        ctx.strokeRect(baseGunX + 3, -3.8, 13, 5.2);
        ctx.fillStyle = '#38BDF8';
        ctx.fillRect(baseGunX + 4.5, -2.4, 3, 2.4);
      } else if (gunKind === 'shotgun') {
        ctx.fillStyle = '#B45309';
        ctx.fillRect(baseGunX - 2, -3.2, 10, 6.4);
        ctx.strokeRect(baseGunX - 2, -3.2, 10, 6.4);
        ctx.fillStyle = '#1E3A5F';
        ctx.fillRect(baseGunX + 7, -2.4, 21, 4.8);
        ctx.strokeRect(baseGunX + 7, -2.4, 21, 4.8);
        ctx.fillStyle = '#C2410C';
        ctx.fillRect(baseGunX + 10, -1.6, 8, 4.8);
        ctx.strokeRect(baseGunX + 10, -1.6, 8, 4.8);
      } else {
        const receiver = ctx.createLinearGradient(0, -3.4, 0, 3.4);
        receiver.addColorStop(0, '#788390');
        receiver.addColorStop(0.35, '#414D59');
        receiver.addColorStop(1, '#18232D');
        ctx.fillStyle = receiver;
        ctx.fillRect(baseGunX - 2, -3.4, 22, 6.8);
        ctx.strokeRect(baseGunX - 2, -3.4, 22, 6.8);
        ctx.fillStyle = '#26323D';
        ctx.fillRect(baseGunX + 20, -1.65, 8, 3.3);
        ctx.strokeRect(baseGunX + 20, -1.65, 8, 3.3);
        ctx.fillStyle = '#AAB5BB';
        ctx.fillRect(baseGunX + 6, -2.5, 9, 0.8);
      }

      drawGrip(rx, ry, 1);
      drawGrip(lx, ly, -1);
      drawMuzzleFlash(ctx, baseGunX + (gunKind === 'sniper' ? 35 : 28), 0, flash);
    }
    ctx.restore();
  }

  // 4. 單一圓形身體（無肩膀橢圓！）
  ctx.beginPath();
  ctx.arc(0, 0, bodyR, 0, Math.PI * 2);
  if (!isHitWhite && skin) {
    const dome = ctx.createRadialGradient(-bodyR * 0.22, -bodyR * 0.22, bodyR * 0.12, 0, 0, bodyR);
    dome.addColorStop(0, skin.bodyHighlight);
    dome.addColorStop(0.72, skin.bodyColor);
    dome.addColorStop(1, '#020617');
    ctx.fillStyle = dome;
  } else {
    ctx.fillStyle = bodyColor;
  }
  ctx.fill();
  ctx.lineWidth = role === 'PLAYER' ? 2.6 : 2.1;
  ctx.strokeStyle = role === 'PLAYER' ? '#FFFFFF' : '#020617';
  ctx.stroke();

  // 5. 面部、眼瞳、護目鏡與頭盔飾條
  if (!isHitWhite && skin) {
    if (skin.faceSkinColor) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, bodyR - 1, -0.68, 0.68);
      ctx.quadraticCurveTo(bodyR * 0.72, 0, Math.cos(-0.68) * (bodyR - 1), Math.sin(-0.68) * (bodyR - 1));
      ctx.closePath();
      ctx.fillStyle = skin.faceSkinColor;
      ctx.fill();
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = isBlinded ? '#FEF08A' : skin.visorColor;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(bodyR * 0.7, side * bodyR * 0.27, bodyR * 0.1, bodyR * 0.13, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (skin.hairOrCrest === 'standard_visor') {
      ctx.beginPath();
      ctx.arc(0, 0, bodyR * 0.82, -0.62, 0.62);
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = Math.max(3.8, bodyR * 0.28);
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, bodyR * 0.82, -0.56, 0.56);
      ctx.strokeStyle = isBlinded ? '#FEF08A' : skin.trimColor;
      ctx.lineWidth = Math.max(2, bodyR * 0.15);
      ctx.lineCap = 'round';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'spiky_crest') {
      ctx.beginPath();
      ctx.moveTo(-bodyR * 0.12, -bodyR * 0.72);
      ctx.lineTo(bodyR * 0.85, 0);
      ctx.lineTo(-bodyR * 0.12, bodyR * 0.72);
      ctx.lineTo(bodyR * 0.24, 0);
      ctx.closePath();
      ctx.fillStyle = skin.trimColor;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'twintail_bow') {
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(-bodyR * 0.45, side * bodyR * 0.46);
        ctx.rotate(side * 0.32);
        ctx.beginPath();
        ctx.ellipse(0, 0, bodyR * 0.26, bodyR * 0.36, 0, 0, Math.PI * 2);
        ctx.fillStyle = skin.trimColor;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#020617';
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(-bodyR * 0.35, 0, bodyR * 0.19, 0, Math.PI * 2);
      ctx.fillStyle = skin.trimColor;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'horned_mask') {
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(bodyR * 0.48, side * bodyR * 0.38);
        ctx.rotate(side * 0.42);
        ctx.beginPath();
        ctx.ellipse(0, 0, bodyR * 0.21, bodyR * 0.11, 0, 0, Math.PI * 2);
        ctx.fillStyle = isBlinded ? '#FEF08A' : skin.visorColor;
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.moveTo(bodyR * 0.14, side * bodyR * 0.42);
        ctx.lineTo(-bodyR * 1.05, side * bodyR * 0.88);
        ctx.lineTo(-bodyR * 0.16, side * bodyR * 0.24);
        ctx.closePath();
        ctx.fillStyle = skin.trimColor;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#020617';
        ctx.stroke();
      }
    } else if (skin.hairOrCrest === 'cyber_visor') {
      ctx.beginPath();
      ctx.arc(0, 0, bodyR * 0.84, -0.68, 0.68);
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = Math.max(4, bodyR * 0.3);
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, bodyR * 0.84, -0.62, 0.62);
      ctx.strokeStyle = isBlinded ? '#FEF08A' : skin.visorColor;
      ctx.lineWidth = Math.max(2.2, bodyR * 0.16);
      ctx.lineCap = 'round';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'royal_wing_crown') {
      ctx.beginPath();
      ctx.moveTo(bodyR * 0.1, -bodyR * 0.92);
      ctx.quadraticCurveTo(bodyR * 0.48, 0, bodyR * 0.1, bodyR * 0.92);
      ctx.quadraticCurveTo(bodyR * 0.7, 0, bodyR * 0.1, -bodyR * 0.92);
      ctx.closePath();
      ctx.fillStyle = skin.trimColor;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'royal_ears_band') {
      ctx.beginPath();
      ctx.arc(0, 0, bodyR * 0.88, -Math.PI * 0.56, Math.PI * 0.56);
      ctx.strokeStyle = skin.trimColor;
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      ctx.stroke();
    } else if (skin.hairOrCrest === 'royal_v_knight') {
      ctx.beginPath();
      ctx.moveTo(-bodyR * 0.12, -bodyR * 0.85);
      ctx.lineTo(bodyR * 0.84, 0);
      ctx.lineTo(-bodyR * 0.12, bodyR * 0.85);
      ctx.lineTo(bodyR * 0.3, 0);
      ctx.closePath();
      ctx.fillStyle = '#0F172A';
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = skin.trimColor;
      ctx.stroke();

      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(bodyR * 0.48, side * bodyR * 0.38);
        ctx.rotate(side * 0.4);
        ctx.beginPath();
        ctx.ellipse(0, 0, bodyR * 0.21, bodyR * 0.12, 0, 0, Math.PI * 2);
        ctx.fillStyle = isBlinded ? '#FEF08A' : skin.visorColor;
        ctx.fill();
        ctx.restore();
      }
    } else if (
      skin.hairOrCrest === 'merc_cloak_goggles' ||
      skin.hairOrCrest === 'merc_ponytail_goggles' ||
      skin.hairOrCrest === 'merc_spiky_goggles'
    ) {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(bodyR * 0.25, side * bodyR * 0.48, bodyR * 0.36, 0, Math.PI * 2);
        ctx.fillStyle = skin.trimColor;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#020617';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(bodyR * 0.25, side * bodyR * 0.48, bodyR * 0.21, 0, Math.PI * 2);
        ctx.fillStyle = isBlinded ? '#FEF08A' : skin.visorColor;
        ctx.fill();
      }
    } else if (skin.hairOrCrest === 'merc_gem_band') {
      ctx.beginPath();
      ctx.arc(0, 0, bodyR * 0.88, -Math.PI * 0.56, Math.PI * 0.56);
      ctx.strokeStyle = skin.trimColor;
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(-bodyR * 0.05, 0, bodyR * 0.24, 0, Math.PI * 2);
      ctx.fillStyle = skin.visorColor;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#020617';
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = isBlinded ? '#FEF08A' : '#0F172A';
    ctx.fillRect(bodyR * 0.32, -bodyR * 0.45, bodyR * 0.42, bodyR * 0.9);
  }

  if (eagleEyeRemaining > 0 && !isBlinded) {
    drawEagleEyeVisor(ctx, bodyR, eagleEyeRemaining);
  }

  if (isFrozen) {
    ctx.beginPath();
    ctx.arc(0, 0, bodyR * 1.04, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.36)';
    ctx.fill();
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#BAE6FD';
    ctx.stroke();

    // 寒冰結晶光澤稜線
    ctx.strokeStyle = 'rgba(240, 249, 255, 0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-bodyR * 0.55, -bodyR * 0.25);
    ctx.lineTo(-bodyR * 0.22, -bodyR * 0.58);
    ctx.moveTo(bodyR * 0.12, bodyR * 0.48);
    ctx.lineTo(bodyR * 0.52, bodyR * 0.14);
    ctx.stroke();
  }

  ctx.restore();
}

export function drawBeamTracers(ctx: CanvasRenderingContext2D, beams: BeamTracer[]) {
  for (const b of beams) {
    const alpha = clamp(b.life / b.maxLife, 0, 1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(1, b.width * 0.45);
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
    ctx.restore();
  }
}

export function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[]) {
  for (const pt of particles) {
    ctx.globalAlpha = clamp(pt.life / pt.maxLife, 0, 1);
    ctx.fillStyle = pt.color;
    ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
  }
  ctx.globalAlpha = 1;
}

export function drawFloatingTexts(ctx: CanvasRenderingContext2D, texts: FloatingText[]) {
  for (const ft of texts) {
    ctx.globalAlpha = clamp(ft.life / ft.maxLife, 0, 1);
    drawOutlinedText(
      ctx,
      ft.text,
      ft.x,
      ft.y,
      ft.color,
      Math.round(13 * ft.scale),
      'center',
      'rgba(0, 0, 0, 0.85)',
      ft.subtle ? '"Noto Sans TC", sans-serif' : '"CyrBit", "Noto Sans TC", "JetBrains Mono", sans-serif',
      ft.subtle ? 500 : 700,
      ft.subtle ? 1.5 : 3.2
    );
  }
  ctx.globalAlpha = 1;
}

export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  mx: number,
  my: number,
  time: number,
  radiusPx: number,
  isReloading: boolean,
  isEmptyMag: boolean,
  eagleEyeActive: boolean,
  comboEmpowerActive: boolean
) {
  ctx.save();
  ctx.translate(mx, my);

  if (isReloading) {
    // 換子彈圖示（對應 換子彈.png：雙橘黃順時針旋轉彎曲箭頭）
    ctx.rotate(time * 4.5);
    for (const baseAng of [0, Math.PI]) {
      ctx.save();
      ctx.rotate(baseAng);
      ctx.beginPath();
      ctx.arc(0, 0, 12, -0.35, 1.55);
      ctx.strokeStyle = '#FEF08A';
      ctx.lineWidth = 6.2;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, 12, -0.35, 1.55);
      ctx.strokeStyle = '#F97316';
      ctx.lineWidth = 3.6;
      ctx.lineCap = 'round';
      ctx.stroke();

      const tipX = Math.cos(1.62) * 12;
      const tipY = Math.sin(1.62) * 12;
      ctx.translate(tipX, tipY);
      ctx.rotate(1.62 + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-4, -5.5);
      ctx.lineTo(-4, 5.5);
      ctx.closePath();
      ctx.fillStyle = '#F97316';
      ctx.fill();
      ctx.strokeStyle = '#FEF08A';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();
    }
  } else if (isEmptyMag) {
    // 沒有子彈圖示（對應 沒有子彈.png：紅色空圓環 + 12 道外射警示紅線）
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * 10.5, Math.sin(ang) * 10.5);
      ctx.lineTo(Math.cos(ang) * 15.5, Math.sin(ang) * 15.5);
      ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.lineWidth = 3.2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
    ctx.strokeStyle = eagleEyeActive ? '#FB7185' : comboEmpowerActive ? '#FBBF24' : '#FFFFFF';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 2.0, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
  }

  ctx.restore();
}
