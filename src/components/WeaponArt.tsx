import React from 'react';
import { CharacterSkin, GunKind, MeleeKind } from '../game/types';

interface WeaponSvgProps {
  kind: GunKind | MeleeKind;
  color?: string;
  className?: string;
}

/**
 * 7 種遠程與近戰武器專屬圖示（對應實戰武器原圖造型：小刀、雙爪、武士大刀、小槍、步槍、木托狙擊槍、木托散彈槍）
 */
export const WeaponIconSvg: React.FC<WeaponSvgProps> = ({
  kind,
  className = 'w-16 h-16',
}) => {
  switch (kind) {
    case 'knife':
      return (
        <svg viewBox="0 0 64 64" className={className} fill="none">
          <g transform="rotate(34 32 32)">
            {/* Curved tactical blade: dark spine + bright silver edge */}
            <path
              d="M25 27 C37 26, 48 27, 56 32 C46 36, 36 37, 25 36 Z"
              fill="#E2E8F0"
              stroke="#020617"
              strokeWidth="2.4"
              strokeLinejoin="round"
            />
            <path d="M25 27 C36 26, 47 27, 55 31.5 C45 30.5, 35 30.5, 25 31 Z" fill="#1E293B" />
            {/* Guard */}
            <rect x="22" y="25.5" width="4" height="12" rx="1.2" fill="#0F172A" stroke="#020617" strokeWidth="1.8" />
            {/* Dark navy ergonomic handle */}
            <rect x="8" y="27.5" width="15" height="8" rx="3" fill="#0F172A" stroke="#020617" strokeWidth="2.2" />
            <rect x="10" y="29" width="11" height="4.5" rx="1.5" fill="#1E3A5F" />
          </g>
        </svg>
      );

    case 'claw':
      return (
        <svg viewBox="0 0 64 64" className={className} fill="none">
          {/* Left gauntlet & 3 curved silver claws */}
          <path d="M10 43 L27 42 L25 49 L12 49 Z" fill="#1E3A8A" stroke="#020617" strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M12 43 C11 31, 13 21, 16 14 C16 23, 16 33, 16 43 Z" fill="#E2E8F0" stroke="#020617" strokeWidth="1.8" />
          <path d="M17 42 C17 29, 19 18, 22 11 C22 21, 21 32, 21 42 Z" fill="#F8FAFC" stroke="#020617" strokeWidth="1.8" />
          <path d="M22 42 C23 31, 25 22, 27 16 C27 25, 26 34, 26 42 Z" fill="#CBD5E1" stroke="#020617" strokeWidth="1.8" />
          {/* Right gauntlet & 3 curved silver claws */}
          <path d="M37 42 L54 43 L52 49 L39 49 Z" fill="#1E3A8A" stroke="#020617" strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M38 42 C38 34, 37 25, 37 16 C39 22, 41 31, 42 42 Z" fill="#CBD5E1" stroke="#020617" strokeWidth="1.8" />
          <path d="M43 42 C43 32, 42 21, 42 11 C45 18, 47 29, 47 42 Z" fill="#F8FAFC" stroke="#020617" strokeWidth="1.8" />
          <path d="M48 43 C48 33, 48 23, 48 14 C51 21, 53 31, 52 43 Z" fill="#E2E8F0" stroke="#020617" strokeWidth="1.8" />
        </svg>
      );

    case 'greatsword':
      return (
        <svg viewBox="0 0 64 64" className={className} fill="none">
          <defs>
            <linearGradient id="katanaSpineA" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#334155" />
              <stop offset="100%" stopColor="#64748B" />
            </linearGradient>
            <radialGradient id="katanaPommelA" cx="35%" cy="35%" r="65%">
              <stop offset="0%" stopColor="#FEF3C7" />
              <stop offset="55%" stopColor="#F59E0B" />
              <stop offset="100%" stopColor="#B45309" />
            </radialGradient>
          </defs>
          <g transform="rotate(-38 32 32)">
            {/* 方案 A：經典光暈太刀（粗黑描邊＋微彎藍灰銀刃＋暖金鍔＋藍鋼菱格柄＋發光金球首） */}
            <path
              d="M22.5 29.2 Q41 29.6, 61.5 26.8 L56.2 32.8 Q40 35.4, 22.5 34.8 Z"
              fill="#F8FAFC"
              stroke="#020617"
              strokeWidth="2.3"
              strokeLinejoin="round"
            />
            {/* 藍灰金屬刀背漸層 */}
            <path
              d="M23.0 29.5 Q41 29.9, 60.0 27.3 L57.5 30.2 Q40.5 32.2, 23.0 32.0 Z"
              fill="url(#katanaSpineA)"
            />
            {/* 黃金鎺口＆緊湊暖金鍔 */}
            <rect x="20" y="29.3" width="3.2" height="5.4" fill="#F59E0B" stroke="#020617" strokeWidth="1.6" />
            <rect x="17.2" y="26.2" width="3.4" height="11.6" rx="1.2" fill="#EAB308" stroke="#020617" strokeWidth="2.0" />
            {/* 藍鋼菱格柄 */}
            <rect x="5.8" y="29.4" width="11.5" height="5.2" rx="1.2" fill="#1E293B" stroke="#020617" strokeWidth="1.9" />
            <path d="M7.6 32 L9.3 30.2 L11.0 32 L9.3 33.8 Z" fill="#94A3B8" />
            <path d="M11.6 32 L13.3 30.2 L15.0 32 L13.3 33.8 Z" fill="#94A3B8" />
            <rect x="15.3" y="29.7" width="1.9" height="4.6" fill="#EAB308" />
            {/* 突出發光圓形金球首 */}
            <circle cx="3.8" cy="32" r="4.9" fill="rgba(251, 191, 36, 0.35)" />
            <circle cx="3.8" cy="32" r="3.6" fill="url(#katanaPommelA)" stroke="#020617" strokeWidth="1.9" />
            <circle cx="3.8" cy="32" r="1.7" fill="#F59E0B" stroke="#78350F" strokeWidth="0.9" />
          </g>
        </svg>
      );

    case 'pistol':
      return (
        <svg viewBox="0 0 64 64" className={className} fill="none">
          <g transform="rotate(24 32 32)">
            {/* Tactical dark gunmetal/navy slide */}
            <rect x="14" y="19" width="34" height="10" rx="2" fill="#0F172A" stroke="#020617" strokeWidth="2.4" />
            <rect x="16" y="20.5" width="29" height="4.5" rx="1" fill="#334155" />
            <rect x="16" y="25" width="30" height="3" fill="#1E293B" />
            {/* Frame & trigger guard */}
            <path d="M18 29 L42 29 L42 32.5 L31 32.5 L30 38 L22 38 L23 32 L18 32 Z" fill="#0F172A" stroke="#020617" strokeWidth="2" />
            {/* Textured pistol grip */}
            <path d="M16 29 L26 29 L23 47 L13 46 Z" fill="#020617" stroke="#020617" strokeWidth="2" />
            <rect x="17" y="32.5" width="5.5" height="11" rx="1" fill="#1E293B" />
          </g>
        </svg>
      );

    case 'rifle':
      return (
        <svg viewBox="0 0 64 64" className={className} fill="none">
          <g transform="rotate(26 32 32)">
            {/* Barrel & front sight */}
            <rect x="44" y="25.5" width="15" height="3.2" fill="#1E293B" stroke="#020617" strokeWidth="1.6" />
            <path d="M48 25.5 L50 20 L52 25.5 Z" fill="#0F172A" stroke="#020617" strokeWidth="1.5" />
            {/* Handguard & M4 Receiver */}
            <rect x="20" y="23.5" width="26" height="7.5" rx="1.2" fill="#0F172A" stroke="#020617" strokeWidth="2" />
            <rect x="33" y="24" width="12" height="6.5" rx="1" fill="#1E3A5F" stroke="#020617" strokeWidth="1.4" />
            {/* Carry Handle */}
            <path d="M22 23.5 L24 18.5 L34 18.5 L35 23.5" fill="none" stroke="#020617" strokeWidth="3.2" strokeLinejoin="round" />
            <path d="M22 23.5 L24 18.5 L34 18.5 L35 23.5" fill="none" stroke="#334155" strokeWidth="1.6" strokeLinejoin="round" />
            {/* Stock */}
            <path d="M4 23.5 L20 24 L20 30 L8 35 L4 33 Z" fill="#0F172A" stroke="#020617" strokeWidth="2" />
            {/* Curved Magazine & Grip */}
            <path d="M31 31 L36.5 31 L39 45 L33 46 Z" fill="#1E293B" stroke="#020617" strokeWidth="1.9" />
            <path d="M21 31 L26 31 L23.5 42 L19 41 Z" fill="#0F172A" stroke="#020617" strokeWidth="1.8" />
          </g>
        </svg>
      );

    case 'sniper':
      return (
        <svg viewBox="0 0 64 64" className={className} fill="none">
          <g transform="rotate(24 32 32)">
            {/* Long dark blue-steel barrel */}
            <rect x="30" y="24.5" width="29" height="3.6" rx="1" fill="#1E3A5F" stroke="#020617" strokeWidth="1.8" />
            {/* Wooden Rifle Stock & Forend */}
            <path
              d="M4 28 L17 26 L38 26 L38 31.5 L22 32 L18 40 L14 39 L16 33 L7 38 L4 35 Z"
              fill="#B45309"
              stroke="#020617"
              strokeWidth="2.1"
              strokeLinejoin="round"
            />
            <rect x="24" y="25" width="13" height="5" fill="#0F172A" />
            {/* Prominent Blue-Steel Magnified Scope */}
            <rect x="20" y="15.5" width="20" height="5.8" rx="1.6" fill="#1E3A5F" stroke="#020617" strokeWidth="1.9" />
            <circle cx="20.5" cy="18.4" r="3.1" fill="#38BDF8" stroke="#020617" strokeWidth="1.5" />
            <circle cx="40" cy="18.4" r="3.3" fill="#38BDF8" stroke="#020617" strokeWidth="1.5" />
            <rect x="24.5" y="21.2" width="2.8" height="3.8" fill="#0F172A" />
            <rect x="33.5" y="21.2" width="2.8" height="3.8" fill="#0F172A" />
          </g>
        </svg>
      );

    case 'shotgun':
      return (
        <svg viewBox="0 0 64 64" className={className} fill="none">
          <g transform="rotate(24 32 32)">
            {/* Dark steel barrel & tube */}
            <rect x="24" y="22.5" width="33" height="4.2" rx="1" fill="#1E3A5F" stroke="#020617" strokeWidth="1.9" />
            {/* Receiver */}
            <rect x="16" y="22.5" width="16" height="8" rx="1.5" fill="#0F172A" stroke="#020617" strokeWidth="2.1" />
            {/* Warm Wood Pump Forend */}
            <rect x="33" y="26.5" width="15" height="5.5" rx="1.5" fill="#C2410C" stroke="#020617" strokeWidth="2" />
            {/* Classic Wooden Stock */}
            <path d="M3 29 L17 24.5 L18 31 L8 39 L3 36 Z" fill="#B45309" stroke="#020617" strokeWidth="2.1" strokeLinejoin="round" />
          </g>
        </svg>
      );

    case 'shield':
      return (
        <svg viewBox="0 0 64 64" className={className} fill="none">
          {/* Outer armored ballistic shield body */}
          <rect
            x="16"
            y="8"
            width="32"
            height="48"
            rx="7"
            fill="#0F172A"
            stroke="#64748B"
            strokeWidth="2.6"
          />
          <rect x="20" y="12" width="24" height="40" rx="4" fill="#1E293B" stroke="#38BDF8" strokeWidth="1.8" />
          {/* Ballistic visor viewport */}
          <rect x="23" y="16" width="18" height="8" rx="2" fill="#020617" stroke="#94A3B8" strokeWidth="1.5" />
          <rect x="25" y="18" width="14" height="3.8" rx="1" fill="#BAE6FD" />
          {/* Reinforcement bar & rivets */}
          <line x1="23" y1="32" x2="41" y2="32" stroke="#475569" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="25" cy="43" r="2" fill="#94A3B8" stroke="#020617" strokeWidth="1.2" />
          <circle cx="39" cy="43" r="2" fill="#94A3B8" stroke="#020617" strokeWidth="1.2" />
        </svg>
      );
  }
};

/**
 * 陣營角色頭像預覽 SVG（正俯視角：圓形身體 + 雙手，無肩膀，對應三大陣營實戰角色原圖）
 */
export const CharacterAvatarSvg: React.FC<{ skin: CharacterSkin; className?: string }> = ({
  skin,
  className = 'w-12 h-12',
}) => {
  const gradId = `charBody_${skin.id}`;
  const handGradId = `charHand_${skin.id}`;
  return (
    <svg viewBox="0 0 64 64" className={className} fill="none">
      <defs>
        <radialGradient id={gradId} cx="42%" cy="38%" r="62%">
          <stop offset="0%" stopColor={skin.bodyHighlight} />
          <stop offset="72%" stopColor={skin.bodyColor} />
          <stop offset="100%" stopColor="#020617" />
        </radialGradient>
        <radialGradient id={handGradId} cx="35%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.65" />
          <stop offset="45%" stopColor={skin.handColor} />
          <stop offset="100%" stopColor={skin.handColor} />
        </radialGradient>
      </defs>

      {/* Drop shadow */}
      <ellipse cx="34" cy="35" rx="18" ry="17" fill="rgba(0,0,0,0.35)" />

      {/* Back accessories */}
      {skin.hairOrCrest === 'spiky_crest' && (
        <path
          d="M36 16 C28 11, 20 13, 14 17 L18 20 C12 21, 7 24, 5 27 L13 28 C8 31, 6 34, 6 36 L13 37 C8 40, 10 44, 15 46 L19 44 C22 49, 29 51, 37 47 Z"
          fill={skin.hairColor}
          stroke="#020617"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      )}

      {skin.hairOrCrest === 'twintail_bow' && (
        <>
          <path
            d="M23 31 C16 25, 10 27, 4 31 C8 36, 13 39, 22 36 Z"
            fill={skin.hairColor}
            stroke="#020617"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
          <path d="M35 16 L41 11 L43 18 Z" fill={skin.trimColor} stroke="#020617" strokeWidth="1.8" />
          <path d="M35 48 L41 53 L43 46 Z" fill={skin.trimColor} stroke="#020617" strokeWidth="1.8" />
        </>
      )}

      {skin.hairOrCrest === 'horned_mask' && (
        <path
          d="M28 42 C21 48, 12 50, 7 47 C11 45, 14 42, 16 39 C11 41, 7 40, 5 37 C11 35, 17 34, 24 35 Z"
          fill={skin.hairColor}
          stroke="#020617"
          strokeWidth="2.1"
          strokeLinejoin="round"
        />
      )}

      {skin.hairOrCrest === 'cyber_visor' && (
        <>
          <rect
            x="10"
            y="16"
            width="15"
            height="4.5"
            rx="2"
            transform="rotate(-14 17 18)"
            fill={skin.hairColor}
            stroke="#020617"
            strokeWidth="2"
          />
          <rect x="29" y="13" width="8" height="5" rx="2" fill={skin.hairColor} stroke="#020617" strokeWidth="1.8" />
          <rect x="29" y="46" width="8" height="5" rx="2" fill={skin.hairColor} stroke="#020617" strokeWidth="1.8" />
        </>
      )}

      {skin.hairOrCrest === 'royal_wing_crown' && (
        <>
          <path d="M26 22 L10 14 L18 26 Z" fill={skin.hairColor} stroke="#020617" strokeWidth="2" strokeLinejoin="round" />
          <path d="M26 42 L10 50 L18 38 Z" fill={skin.hairColor} stroke="#020617" strokeWidth="2" strokeLinejoin="round" />
        </>
      )}

      {skin.hairOrCrest === 'royal_ears_band' && (
        <>
          <path d="M27 21 L12 13 L20 26 Z" fill={skin.hairColor} stroke={skin.trimColor} strokeWidth="2" strokeLinejoin="round" />
          <path d="M27 43 L12 51 L20 38 Z" fill={skin.hairColor} stroke={skin.trimColor} strokeWidth="2" strokeLinejoin="round" />
        </>
      )}

      {skin.hairOrCrest === 'royal_v_knight' && (
        <>
          <path d="M21 26 L7 23 L16 30 Z" fill="#38BDF8" stroke="#020617" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M21 38 L7 41 L16 34 Z" fill="#38BDF8" stroke="#020617" strokeWidth="1.8" strokeLinejoin="round" />
        </>
      )}

      {skin.hairOrCrest === 'merc_cloak_goggles' && (
        <path
          d="M27 15 C18 11, 11 12, 8 19 L14 29 L8 42 C11 50, 19 52, 28 48 Z"
          fill={skin.hairColor}
          stroke="#020617"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      )}

      {skin.hairOrCrest === 'merc_ponytail_goggles' && (
        <>
          <rect x="8" y="16" width="16" height="4" rx="1.5" fill="#C2410C" stroke="#020617" strokeWidth="1.8" />
          <path
            d="M22 30 C14 24, 9 27, 5 32 C9 37, 15 39, 22 35 Z"
            fill={skin.hairColor}
            stroke="#020617"
            strokeWidth="2.1"
            strokeLinejoin="round"
          />
        </>
      )}

      {skin.hairOrCrest === 'merc_spiky_goggles' && (
        <path
          d="M34 15 C24 11, 14 14, 10 21 L15 24 C10 28, 8 33, 9 37 L14 38 C11 43, 14 48, 22 49 L35 46 Z"
          fill={skin.bodyHighlight}
          stroke="#020617"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      )}

      {skin.hairOrCrest === 'merc_gem_band' && (
        <path
          d="M31 15 L14 19 L18 26 L12 32 L18 38 L14 45 L31 49 Z"
          fill={skin.bodyColor}
          stroke="#020617"
          strokeWidth="2.1"
          strokeLinejoin="round"
        />
      )}

      {/* Two round hands (NO shoulders!) */}
      <circle cx="45" cy="15" r="5.8" fill={skin.handColor} stroke="#020617" strokeWidth="2.4" />
      <circle cx="45" cy="15" r="4.8" fill={`url(#${handGradId})`} />
      <circle cx="45" cy="49" r="5.8" fill={skin.handColor} stroke="#020617" strokeWidth="2.4" />
      <circle cx="45" cy="49" r="4.8" fill={`url(#${handGradId})`} />

      {/* Circular Body / Head Dome */}
      <circle cx="34" cy="32" r="16" fill={`url(#${gradId})`} stroke="#020617" strokeWidth="2.8" />

      {/* Face crescent & glowing eyes */}
      {skin.faceSkinColor && (
        <>
          <path
            d="M42 20 A 15 15 0 0 1 42 44 Q 47 32 42 20 Z"
            fill={skin.faceSkinColor}
            stroke="#020617"
            strokeWidth="1.4"
          />
          <ellipse cx="45.5" cy="27.5" rx="1.6" ry="2.2" fill={skin.visorColor} />
          <ellipse cx="45.5" cy="36.5" rx="1.6" ry="2.2" fill={skin.visorColor} />
        </>
      )}

      {/* Style overlays */}
      {skin.hairOrCrest === 'standard_visor' && (
        <>
          <path d="M40 19 A 14.5 14.5 0 0 1 40 45" stroke="#020617" strokeWidth="5.5" strokeLinecap="round" />
          <path d="M40 20 A 14 14 0 0 1 40 44" stroke={skin.trimColor} strokeWidth="2.8" strokeLinecap="round" />
        </>
      )}

      {skin.hairOrCrest === 'spiky_crest' && (
        <path d="M32 20 L48 32 L32 44 L38 32 Z" fill={skin.trimColor} stroke="#020617" strokeWidth="2" strokeLinejoin="round" />
      )}

      {skin.hairOrCrest === 'twintail_bow' && (
        <>
          <ellipse cx="26" cy="24" rx="4.5" ry="6" transform="rotate(-18 26 24)" fill={skin.trimColor} stroke="#020617" strokeWidth="1.9" />
          <ellipse cx="26" cy="40" rx="4.5" ry="6" transform="rotate(18 26 40)" fill={skin.trimColor} stroke="#020617" strokeWidth="1.9" />
          <circle cx="28" cy="32" r="3.2" fill={skin.trimColor} stroke="#020617" strokeWidth="1.8" />
        </>
      )}

      {skin.hairOrCrest === 'horned_mask' && (
        <>
          <ellipse cx="42" cy="25.5" rx="3.4" ry="1.9" transform="rotate(-24 42 25.5)" fill={skin.visorColor} />
          <ellipse cx="42" cy="38.5" rx="3.4" ry="1.9" transform="rotate(24 42 38.5)" fill={skin.visorColor} />
          <path d="M36 25 L16 17 L31 28 Z" fill={skin.trimColor} stroke="#020617" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M36 39 L16 47 L31 36 Z" fill={skin.trimColor} stroke="#020617" strokeWidth="1.8" strokeLinejoin="round" />
        </>
      )}

      {skin.hairOrCrest === 'cyber_visor' && (
        <>
          <path d="M44 21 A 14.5 14.5 0 0 1 44 43" stroke="#020617" strokeWidth="5.5" strokeLinecap="round" />
          <path d="M44 22 A 14 14 0 0 1 44 42" stroke={skin.visorColor} strokeWidth="3" strokeLinecap="round" />
        </>
      )}

      {skin.hairOrCrest === 'royal_wing_crown' && (
        <path
          d="M36 16 Q42 32 36 48 Q45 32 36 16 Z"
          fill={skin.trimColor}
          stroke="#020617"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      )}

      {skin.hairOrCrest === 'royal_ears_band' && (
        <path d="M29 17 A 15 15 0 0 1 29 47" stroke={skin.trimColor} strokeWidth="3.5" strokeLinecap="round" />
      )}

      {skin.hairOrCrest === 'royal_v_knight' && (
        <>
          <path d="M32 16 L47 32 L32 48 L39 32 Z" fill="#0F172A" stroke={skin.trimColor} strokeWidth="2.2" strokeLinejoin="round" />
          <ellipse cx="42" cy="25" rx="3.2" ry="2" transform="rotate(-22 42 25)" fill={skin.visorColor} />
          <ellipse cx="42" cy="39" rx="3.2" ry="2" transform="rotate(22 42 39)" fill={skin.visorColor} />
        </>
      )}

      {(skin.hairOrCrest === 'merc_cloak_goggles' ||
        skin.hairOrCrest === 'merc_ponytail_goggles' ||
        skin.hairOrCrest === 'merc_spiky_goggles') && (
        <>
          <circle cx="38" cy="24" r="6" fill={skin.trimColor} stroke="#020617" strokeWidth="2" />
          <circle cx="38" cy="24" r="3.6" fill={skin.visorColor} stroke="#020617" strokeWidth="1.2" />
          <circle cx="38" cy="40" r="6" fill={skin.trimColor} stroke="#020617" strokeWidth="2" />
          <circle cx="38" cy="40" r="3.6" fill={skin.visorColor} stroke="#020617" strokeWidth="1.2" />
        </>
      )}

      {skin.hairOrCrest === 'merc_gem_band' && (
        <>
          <path d="M32 17 A 15 15 0 0 1 32 47" stroke={skin.trimColor} strokeWidth="4" strokeLinecap="round" />
          <circle cx="33" cy="32" r="4" fill={skin.visorColor} stroke="#020617" strokeWidth="1.8" />
        </>
      )}
    </svg>
  );
};

/**
 * 三大陣營徽章 SVG（皇家聖翼盾徽、天影暗蝕十字徽、第三傭兵雙刃羅盤徽）
 */
export const FactionLogoSvg: React.FC<{
  faction: 'royal' | 'shadow' | 'mercenary';
  className?: string;
}> = ({ faction, className = 'w-20 h-20' }) => {
  if (faction === 'royal') {
    return (
      <svg viewBox="0 0 100 100" className={className} fill="none">
        <defs>
          <radialGradient id="royalCrestBg" cx="45%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#F8FAFC" />
            <stop offset="55%" stopColor="#CBD5E1" />
            <stop offset="100%" stopColor="#334155" />
          </radialGradient>
          <linearGradient id="royalGold" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FEF08A" />
            <stop offset="50%" stopColor="#F59E0B" />
            <stop offset="100%" stopColor="#B45309" />
          </linearGradient>
        </defs>
        {/* Outer radiant wings */}
        <path d="M18 38 L5 26 L16 50 L8 58 L24 62 Z" fill="#E2E8F0" stroke="#0F172A" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M82 38 L95 26 L84 50 L92 58 L76 62 Z" fill="#E2E8F0" stroke="#0F172A" strokeWidth="2.5" strokeLinejoin="round" />
        {/* Royal Kite Shield */}
        <path
          d="M24 22 L50 14 L76 22 L73 58 C71 73, 50 88, 50 88 C50 88, 29 73, 27 58 Z"
          fill="url(#royalCrestBg)"
          stroke="url(#royalGold)"
          strokeWidth="4"
          strokeLinejoin="round"
        />
        {/* Golden Cross & Halo Gem */}
        <path d="M50 24 V74 M33 43 H67" stroke="url(#royalGold)" strokeWidth="6" strokeLinecap="round" />
        <circle cx="50" cy="43" r="8" fill="#38BDF8" stroke="#F8FAFC" strokeWidth="2.4" />
        {/* Crown spikes */}
        <path d="M36 16 L42 6 L50 12 L58 6 L64 16 Z" fill="url(#royalGold)" stroke="#0F172A" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    );
  }

  if (faction === 'shadow') {
    return (
      <svg viewBox="0 0 100 100" className={className} fill="none">
        <defs>
          <radialGradient id="shadowCrestBg" cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor="#4C1D95" />
            <stop offset="55%" stopColor="#3B0764" />
            <stop offset="100%" stopColor="#090D16" />
          </radialGradient>
        </defs>
        {/* Outer Crimson-Purple Blades */}
        <path d="M50 6 L58 24 L50 20 L42 24 Z" fill="#9D174D" stroke="#020617" strokeWidth="2" />
        <path d="M50 94 L58 76 L50 80 L42 76 Z" fill="#9D174D" stroke="#020617" strokeWidth="2" />
        <path d="M6 50 L24 42 L20 50 L24 58 Z" fill="#6E146B" stroke="#020617" strokeWidth="2" />
        <path d="M94 50 L76 42 L80 50 L76 58 Z" fill="#6E146B" stroke="#020617" strokeWidth="2" />
        {/* Eclipse Medallion */}
        <circle cx="50" cy="50" r="32" fill="url(#shadowCrestBg)" stroke="#A21CAF" strokeWidth="3.5" />
        {/* Crescent Eclipse & Twin Eyes */}
        <path
          d="M58 26 A 24 24 0 1 0 58 74 A 19 19 0 1 1 58 26 Z"
          fill="#D946EF"
          fillOpacity="0.32"
          stroke="#C026D3"
          strokeWidth="2"
        />
        {/* Shadow Cross */}
        <path d="M50 25 V75 M30 46 H70" stroke="#E879F9" strokeWidth="4" strokeLinecap="round" />
        <ellipse cx="42" cy="46" rx="4" ry="2.2" transform="rotate(-18 42 46)" fill="#F43F5E" />
        <ellipse cx="58" cy="46" rx="4" ry="2.2" transform="rotate(18 58 46)" fill="#F43F5E" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 100 100" className={className} fill="none">
      <defs>
        <radialGradient id="mercCrestBg" cx="45%" cy="40%" r="62%">
          <stop offset="0%" stopColor="#B45309" />
          <stop offset="65%" stopColor="#78350F" />
          <stop offset="100%" stopColor="#291206" />
        </radialGradient>
      </defs>
      {/* Crossed Mercenary Sabers */}
      <path d="M18 82 L76 16 L83 22 L25 86 Z" fill="#E2E8F0" stroke="#0F172A" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M82 82 L24 16 L17 22 L75 86 Z" fill="#CBD5E1" stroke="#0F172A" strokeWidth="2.4" strokeLinejoin="round" />
      {/* Bronze Gear-Rim Shield */}
      <circle cx="50" cy="50" r="28" fill="url(#mercCrestBg)" stroke="#F59E0B" strokeWidth="4" />
      <circle cx="50" cy="50" r="20" fill="none" stroke="#FCD34D" strokeWidth="1.6" strokeDasharray="5 4" />
      {/* Lone Wolf Compass Star */}
      <path d="M50 30 L56 44 L70 50 L56 56 L50 70 L44 56 L30 50 L44 44 Z" fill="#FBBF24" stroke="#451A03" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="50" cy="50" r="4.5" fill="#22D3EE" stroke="#0F172A" strokeWidth="1.5" />
    </svg>
  );
};

/**
 * 戰鬥左上方有時效主動技能矩陣圖示 SVG
 */
export const SkillIconSvg: React.FC<{
  id: 'royalShield' | 'eagleEye' | 'shadowClone' | 'vampire' | 'shrink' | 'giant' | 'frozen';
  className?: string;
}> = ({ id, className = 'w-7 h-7' }) => {
  switch (id) {
    case 'royalShield':
      return (
        <svg viewBox="0 0 36 36" className={className} fill="none">
          <path
            d="M8 8 L18 5 L28 8 L27 20 C26 26, 18 31, 18 31 C18 31, 10 26, 9 20 Z"
            fill="#0284C7"
            stroke="#BAE6FD"
            strokeWidth="2.2"
          />
          <path d="M18 10 V25 M12 17 H24" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case 'eagleEye':
      return (
        <svg viewBox="0 0 36 36" className={className} fill="none">
          <path
            d="M4 18 Q18 7 32 18 Q18 29 4 18 Z"
            fill="#881337"
            stroke="#FDA4AF"
            strokeWidth="2.2"
          />
          <circle cx="18" cy="18" r="5" fill="#F43F5E" stroke="#FFFFFF" strokeWidth="1.6" />
          <circle cx="18" cy="18" r="2" fill="#0F172A" />
        </svg>
      );
    case 'shadowClone':
      return (
        <svg viewBox="0 0 36 36" className={className} fill="none">
          <circle cx="12" cy="16" r="6" fill="#6B21A8" stroke="#D8B4FE" strokeWidth="1.8" strokeDasharray="2 2" />
          <circle cx="24" cy="20" r="6" fill="#9333EA" stroke="#F3E8FF" strokeWidth="1.8" />
          <path d="M9 28 C9 23, 15 23, 15 28" stroke="#D8B4FE" strokeWidth="2" />
          <path d="M21 30 C21 25, 27 25, 27 30" stroke="#FFFFFF" strokeWidth="2" />
        </svg>
      );
    case 'vampire':
      return (
        <svg viewBox="0 0 36 36" className={className} fill="none">
          <path
            d="M18 5 C18 5, 28 16, 28 22 A 10 10 0 1 1 8 22 C8 16, 18 5, 18 5 Z"
            fill="#E11D48"
            stroke="#FECDD3"
            strokeWidth="2"
          />
          <path d="M13 18 L15.5 23 L18 18 L20.5 23 L23 18" stroke="#FFFFFF" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );
    case 'shrink':
      return (
        <svg viewBox="0 0 36 36" className={className} fill="none">
          <circle cx="18" cy="18" r="5.5" fill="#FBBF24" stroke="#FFFFFF" strokeWidth="2" />
          <path d="M7 7 L13 13 M13 9 V13 H9" stroke="#FDE047" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M29 29 L23 23 M23 27 V23 H27" stroke="#FDE047" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'giant':
      return (
        <svg viewBox="0 0 36 36" className={className} fill="none">
          <circle cx="18" cy="18" r="9.5" fill="#EA580C" stroke="#FED7AA" strokeWidth="2.2" />
          <path d="M12 12 L6 6 M6 10 V6 H10" stroke="#FDBA74" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M24 24 L30 30 M30 26 V30 H26" stroke="#FDBA74" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'frozen':
      return (
        <svg viewBox="0 0 36 36" className={className} fill="none">
          <circle cx="18" cy="18" r="11" fill="#0369A1" stroke="#BAE6FD" strokeWidth="2" />
          <path
            d="M18 8 V28 M9.3 13 L26.7 23 M26.7 13 L9.3 23"
            stroke="#E0F2FE"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <circle cx="18" cy="18" r="3" fill="#FFFFFF" />
        </svg>
      );
  }
};
