import { sfx, type FootstepSurface } from '../audio/sfx';
import {
  drawBeamTracers,
  drawCharacter,
  drawCrosshair,
  drawFloatingTexts,
  drawMeleeChargeAura,
  drawMeleeChargeSparks,
  drawOutlinedText,
  drawParticles,
  drawPickup,
  drawQiRecovery,
  drawRoyalShield,
  drawSlashEffect,
} from './combatRenderer';
import { drawMorphGround, drawProjectiles, drawSkillTraces, drawVampireMist } from './skillRenderer';
import { FACTIONS, FACTION_CHARACTERS, GUNS, MELEES, getReputationQiMultiplier, getWeaponSwapDuration } from './data';
import {
  SIEGE_CONFIG,
  SIEGE_UPGRADES,
  getDefaultSiegeLoadout,
  getTacticalMeta,
  getUltimateMeta,
  sanitizeSiegeLoadout,
} from './siegeData';
import { SIEGE_MAP_ID } from './siegeMap';
import { drawSiegeFountains, drawSiegeStructures, drawSiegeZones } from './siegeRenderer';
import {
  SiegeHeroState,
  SiegeRuntime,
  applySiegeDefenseReduction,
  computeSiegeDefense,
  computeSiegeGunFalloffMult,
  computeSiegeLevelAttackMult,
  computeSiegeMaxHp,
  computeSiegeMoveSpeedMult,
  computeSiegeRespawnSeconds,
  computeSiegeTacticalCooldown,
  createHeroSiegeState,
  createSiegeRuntime,
  getBossDisplayName,
  getSiegeGunProfile,
  grantSiegeXpAndGold,
  pickSiegeAiHeroTemplate,
  refreshStructureInvulnerability,
  tryPurchaseSiegeUpgrade,
} from './siegeHelpers';
import {
  CHAR_BASE_RADIUS,
  ELEV_PADDING,
  angleDiff,
  areHostile,
  clamp,
  dist,
  getMoveCheckRadius,
  pointInRect,
  resolveCircleRect,
  segmentCircleHit,
  segmentIntersectsRect,
  snapToEightDirections,
  uid,
} from './geometry';
import { renderMapBaseLayer, renderMapCanopies } from './mapRenderer';
import { ArenaMap, TILE, createArenaMap } from './maps';
import {
  AI_COMBAT,
  AI_DIFFICULTY,
  AI_GUN_AIM,
  type AiDifficulty,
  AI_PATROL,
  AI_SURPRISE_SECONDS,
  EAGLE_EYE_DURATION,
  GUN_AIM,
  GUNFIRE_ANIMATION_SECONDS,
  PLAYER_MOVEMENT,
  QI_RATE,
  ROYAL_SHIELD_PADDING,
  SHIELD_BASH_DISTANCE,
  MELEE_CHARGE_HOLD_SECONDS,
  RESPAWN_DELAY_SECONDS,
  RELOAD_CUES,
  RIFLE_RECOIL,
  SNIPER_AIM,
  getGunSpread,
} from './tuning';
import { CustomMapData, buildArenaMapFromCustom } from './customMaps';
import type {
  NetActorSnapshot,
  NetEquippedSlot,
  NetSiegeSnapshot,
  NetTransientEvent,
  NetWorldSnapshot,
  RemotePlayerInput,
} from '../net/protocol';
import {
  ActorSkillVisuals,
  BeamTracer,
  CardinalDir,
  CharacterSkin,
  EnemyArchetype,
  EnemyEntity,
  EquippedWeapon,
  FactionId,
  FloatingText,
  GameMode,
  GridTile,
  GunDef,
  HudSnapshot,
  MeleeDef,
  MeleeKind,
  MultiplayerEngineConfig,
  MultiplayerPeerDescriptor,
  Particle,
  PickupItem,
  PlayerState,
  Projectile,
  PushableIceBlock,
  SiegeBossKind,
  SiegeFactionId,
  SiegeHudState,
  SiegeLane,
  SiegePlayerLoadout,
  SiegeOptions,
  SiegeStructure,
  SiegeUpgradeTrack,
  SkillTrace,
  SlashEffect,
  WeaponHand,
} from './types';

export { snapToEightDirections };

export const VIEWPORT_TILES_X = 16;
export const VIEWPORT_TILES_Y = 12;

const DEFAULT_PISTOL = GUNS.find((gun) => gun.kind === 'pistol') || GUNS[0];
const DEFAULT_KNIFE = MELEES.find((melee) => melee.kind === 'knife') || MELEES[0];
const AI_FIXED_REPUTATION = 100;
const ALL_SKINS_BY_ID = new Map<string, CharacterSkin>(
  (['royal', 'shadow', 'mercenary'] as FactionId[])
    .flatMap((fac) => FACTION_CHARACTERS[fac])
    .map((skin) => [skin.id, skin])
);
const ALL_GUNS_BY_ID = new Map(GUNS.map((g) => [g.id, g]));
const ALL_MELEES_BY_ID = new Map(MELEES.map((m) => [m.id, m]));

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

interface RemoteHumanRuntime {
  peerId: string;
  entityId: string;
  name: string;
  faction: FactionId;
  startingReputation?: number;
  reputationChanges: Record<FactionId, number>;
  characterSkin: CharacterSkin;
  lives: number;
  maxLives: number;
  reserveAmmo: number;
  maxReserveAmmo: number;
  score: number;
  totalDamage: number;
  kills: number;
  comboCount: number;
  maxCombo: number;
  comboTimer: number;
  respawnTimer: number;
  rifleRecoilAngle: number;
  chargeSessionAllowed: boolean;
  qiFastRefund?: boolean;
  meleeHeldSeconds: number;
  lastAttackAt: number;
  delayCancelReady: boolean;
  comboEmpowerTimer: number;
  delayCancelBonus: number;
  prevAimX: number;
  prevAimY: number;
  lastAimBloomAt: number;
  wasMouseDown: boolean;
  lastClickSeq: number;
  lastReloadSeq: number;
  lastSwapSeq: number;
  lastPickupSeq: number;
  lastDropSeq: number;
  lastTacticalSeq: number;
  lastUltSeq: number;
  lastRecallSeq: number;
  lastUpgradeSeq: number;
  disconnected?: boolean;
  siegeLoadout?: SiegePlayerLoadout;
  input: RemotePlayerInput;
}

interface ClientLerpTarget {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  elev: number;
  extrapTime: number;
}

type ReputationChangeHandler = (reps: Record<FactionId, number>, change: Record<FactionId, number>) => void;

function equipGun(def: GunDef, ammoInMag = def.magSize): Extract<EquippedWeapon, { type: 'gun' }> {
  return {
    type: 'gun',
    def,
    ammoInMag: clamp(Math.round(ammoInMag), 0, def.magSize),
    reloadTimer: 0,
  };
}

function defaultWeaponForHand(hand: WeaponHand): EquippedWeapon {
  return hand === 0 ? equipGun(DEFAULT_PISTOL) : { type: 'melee', def: DEFAULT_KNIFE, durability: 0 };
}

function applyFrontalShieldMitigation(
  rawDmg: number,
  shieldDurability: number,
  isMeleeAttack: boolean
): { finalDmg: number; nextDurability: number; banner?: { text: string; color: string } } {
  if (!isMeleeAttack) {
    const absorbed = Math.min(shieldDurability, rawDmg);
    const nextDurability = Math.max(0, shieldDurability - absorbed);
    return {
      finalDmg: rawDmg - absorbed,
      nextDurability,
      banner:
        absorbed > 0
          ? {
              text: `-${absorbed}`,
              color: '#FFFFFF',
            }
          : undefined,
    };
  }
  const halfDmg = Math.max(1, Math.round(rawDmg * 0.5));
  const blockedAmt = Math.max(1, rawDmg - halfDmg);
  const nextDurability = Math.max(0, shieldDurability - blockedAmt);
  return {
    finalDmg: halfDmg,
    nextDurability,
    banner: {
      text: `-${blockedAmt}`,
      color: '#FFFFFF',
    },
  };
}

function evaluateBlackDragonHit(
  proj: Projectile,
  segs: { x: number; y: number }[],
  prevX: number,
  prevY: number,
  targetX: number,
  targetY: number,
  targetRadius: number
): { hitDmg: number; hitOriginX: number; hitOriginY: number } | null {
  if (dist(proj.x, proj.y, targetX, targetY) <= targetRadius + 18) {
    return { hitDmg: proj.headDamage ?? 20, hitOriginX: prevX, hitOriginY: prevY };
  }
  for (let k = 1; k < segs.length; k++) {
    if (dist(segs[k].x, segs[k].y, targetX, targetY) <= targetRadius + 13) {
      return { hitDmg: proj.bodyDamage ?? 15, hitOriginX: segs[k].x, hitOriginY: segs[k].y };
    }
  }
  return null;
}

export class TwilightEngine {
  public mode: GameMode = 'frontier';
  public siege: SiegeRuntime | null = null;
  public mapId: string;
  public status: HudSnapshot['status'] = 'PLAYING';
  public map: ArenaMap;
  public player: PlayerState;
  public enemies: EnemyEntity[] = [];
  public projectiles: Projectile[] = [];
  public beams: BeamTracer[] = [];
  public slashes: SlashEffect[] = [];
  public particles: Particle[] = [];
  private skillTraces: SkillTrace[] = [];
  private actorSkillVisuals = new WeakMap<PlayerState | EnemyEntity, ActorSkillVisuals>();
  public floatingTexts: FloatingText[] = [];
  public pickups: PickupItem[] = [];

  public bannerText = '';
  public bannerTimer = 0;
  public activeSkillBanner = '';
  public activeSkillBannerTimer = 0;
  public factionScores: Record<FactionId, number> = { royal: 0, shadow: 0, mercenary: 0 };

  // 合計 10 名士兵配置（含玩家 1 人 + 9 名電腦士兵），場上同陣營最多 2 人
  private deploymentQueue: Record<FactionId, number> = { royal: 0, shadow: 0, mercenary: 0 };
  private spawnStaggerTimer = 0;

  private keys = new Set<string>();
  private mouseScreen = { x: 640, y: 360 };
  private mouseDown = false;
  private chargeSessionAllowed = false;
  private qiFastRefund = false;
  private meleeHeldSeconds = 0;
  private crosshairBloom = 0;
  private crosshairBloomDelay = 0;
  private rifleRecoilAngle = 0;
  private viewport = { width: 1280, height: 720 };
  private respawnTimer = 0;
  private distanceSinceStep = 0;
  private camera = { x: 0, y: 0, shake: 0, zoom: 1.5 };
  private cameraLookOffset = { x: 0, y: 0 };
  private time = 0;
  private hudEmitTimer = 0;
  private navStandable = new Set<number>();
  private navAdj = new Map<number, number[]>();
  private wallCellKeys = new Set<string>();
  private framePushInputs: {
    id: string;
    isPlayer: boolean;
    faction: FactionId;
    x: number;
    y: number;
    radius: number;
    elevation: number;
    dirX: number;
    dirY: number;
  }[] = [];
  private onHudUpdate: (snap: HudSnapshot) => void;
  private onReputationChange?: ReputationChangeHandler;
  private readonly multiplayer?: MultiplayerEngineConfig;
  private remoteHumans = new Map<string, RemoteHumanRuntime>();
  private netEvents: NetTransientEvent[] = [];
  private snapshotSeq = 0;
  private forceNextKeyframe = false;
  private lastReputationSnapshotSeq = 0;
  private appliedReputationChanges: Record<FactionId, number> = { royal: 0, shadow: 0, mercenary: 0 };
  private spectatorMode: 'follow' | 'free' = 'follow';
  private spectatorTargetId: string | null = null;
  private lastExportedPickupsSig = '';
  private lastExportedIceSig = '';
  private hasEmittedClientHud = false;
  private clientLerpTargets = new Map<string, ClientLerpTarget>();

  constructor(
    faction: FactionId,
    characterSkin: CharacterSkin,
    mapId: string,
    initialReputations: Record<FactionId, number>,
    onHudUpdate: (snap: HudSnapshot) => void,
    onReputationChange?: ReputationChangeHandler,
    customMap?: CustomMapData,
    private readonly difficulty: AiDifficulty = 'standard',
    multiplayer?: MultiplayerEngineConfig,
    mode: GameMode = 'frontier',
    siegeOptions?: SiegeOptions
  ) {
    this.mode = mode;
    const activeFaction: FactionId = mode === 'siege' && faction === 'mercenary' ? 'royal' : faction;
    const effectiveMapId = mode === 'siege' && !customMap ? SIEGE_MAP_ID : mapId;
    this.mapId = effectiveMapId;
    this.onHudUpdate = onHudUpdate;
    this.onReputationChange = onReputationChange;
    this.multiplayer = multiplayer;

    this.map = customMap ? buildArenaMapFromCustom(customMap) : createArenaMap(effectiveMapId);
    const fac = FACTIONS[activeFaction];
    const startGun = GUNS.find((g) => g.id === fac.startGunId) || GUNS[0];
    const startMelee = MELEES.find((m) => m.id === fac.startMeleeId) || MELEES[0];

    if (mode === 'siege') {
      const siegeFac: SiegeFactionId = activeFaction === 'shadow' ? 'shadow' : 'royal';
      this.siege = createSiegeRuntime(siegeFac, characterSkin.id, siegeOptions?.loadout, siegeOptions?.durationSec);
    }

    const siegeLoadout = this.siege?.playerState.loadout;
    const chosenGun = (siegeLoadout && ALL_GUNS_BY_ID.get(siegeLoadout.gunId)) || startGun;
    const chosenMelee = (siegeLoadout && ALL_MELEES_BY_ID.get(siegeLoadout.meleeId)) || startMelee;
    const spawnPt = this.siege
      ? this.siege.spec.fountains[activeFaction === 'shadow' ? 'shadow' : 'royal']
      : this.map.factionSpawns[activeFaction][0] || { x: this.map.width / 2, y: this.map.height / 2 };

    const normalizedReps: Record<FactionId, number> = {
      royal: Math.floor(Number.isFinite(initialReputations.royal) ? initialReputations.royal : 0),
      shadow: Math.floor(Number.isFinite(initialReputations.shadow) ? initialReputations.shadow : 0),
      mercenary: Math.floor(Number.isFinite(initialReputations.mercenary) ? initialReputations.mercenary : 0),
    };

    const startMaxHp = this.siege ? computeSiegeMaxHp(this.siege.playerState) : 100;

    this.player = {
      x: spawnPt.x,
      y: spawnPt.y,
      vx: 0,
      vy: 0,
      baseRadius: CHAR_BASE_RADIUS,
      radius: CHAR_BASE_RADIUS,
      sizeScale: 1,
      angle: 0,
      walkPhase: 0,
      moveIntensity: 0,
      elevation: 0,
      hp: startMaxHp,
      maxHp: startMaxHp,
      maxShield: 100,
      qi: 100,
      maxQi: 100,
      lives: this.siege ? 999 : 3,
      maxLives: this.siege ? 999 : 3,
      reputation: normalizedReps[activeFaction],
      reputations: normalizedReps,
      score: 0,
      totalDamage: 0,
      kills: 0,
      maxCombo: 0,
      comboCount: 0,
      comboTimer: 0,
      faction: activeFaction,
      characterSkin,
      activeHand: 0,
      weapons: [
        equipGun(chosenGun),
        {
          type: 'melee',
          def: chosenMelee,
          durability: chosenMelee.kind === 'shield' ? 100 : 0,
        },
      ],
      reserveAmmo: this.siege ? 45 : 30,
      maxReserveAmmo: this.siege ? 60 : 45,
      swapTimer: 0,
      swapDuration: 0,
      gunfireTimer: 0,
      attackAnimTimer: 0,
      attackAnimDuration: 0,
      attackAnimKind: null,
      attackCooldown: 0,
      lastAttackAt: -10,
      delayCancelReady: false,
      comboEmpowerTimer: 0,
      chargingMelee: false,
      chargeReady: false,
      royalShieldTimer: 0,
      eagleEyeTimer: 0,
      shadowCloneTimer: 0,
      vampireTimer: 0,
      shrinkTimer: 0,
      giantTimer: 0,
      blindTimer: 0,
      blindDuration: 0,
      freezeTimer: 0,
      invulnTimer: 1.5,
      delayCancelBonus: 0.25,
    };
    this.player.elevation = this.getWalkableElevation(this.player.x, this.player.y);

    this.camera.zoom = this.getBaseZoom(1280, 720);
    const initCam = this.clampCameraToMap(this.player.x, this.player.y, 1280, 720);
    this.camera.x = initCam.x;
    this.camera.y = initCam.y;

    // 三大陣營各自擁有 10 名士兵總兵力（合計 30 人），同陣營場上最多 2 人（真人可自由組隊不受 2 人AI上限限制）
    this.deploymentQueue = this.siege
      ? { royal: 0, shadow: 0, mercenary: 0 }
      : {
          royal: 10,
          shadow: 10,
          mercenary: 10,
        };
    if (multiplayer) {
      if (!this.siege) {
        for (const peer of multiplayer.peers) {
          this.deploymentQueue[peer.faction] = Math.max(0, this.deploymentQueue[peer.faction] - 1);
        }
      }
      if (multiplayer.role === 'host') {
        this.initRemoteHumans(multiplayer);
      }
    } else if (!this.siege) {
      this.deploymentQueue[activeFaction] = 9; // 玩家已佔用己方陣營第 1 席
    }

    this.buildNavigationGraph();
    if (this.siege) {
      if (multiplayer?.role !== 'client') {
        this.initSiegeTeams();
      }
      this.showBanner(`${this.map.name} · 5v5 三路推塔攻防戰！摧毀敵方主城堡即奪勝！`, 5.0);
    } else {
      this.spawnMapWeapons();
      this.spawnMapAmmoPickups();
      this.spawnMapShieldPickups();
      if (multiplayer?.role !== 'client') {
        this.refillFieldUpToCap();
      }

      const winObjective =
        activeFaction === 'mercenary'
          ? '第三勢力勝利條件：擊敗場上與後備全數敵我角色！'
          : `${fac.name}勝利條件：清除全數非己方勢力敵軍！`;
      this.showBanner(`${this.map.name} · 各陣營 10 兵編制（同陣營上限 2 人） · ${winObjective}`, 4.5);
    }
    this.emitHud();
  }

  private tileIndex(gx: number, gy: number): number {
    return gy * this.map.cols + gx;
  }

  private hasTreeTrunkNear(x: number, y: number, padRadius: number): boolean {
    for (const tree of this.map.trees) {
      if (resolveCircleRect(x, y, padRadius, tree).hit) return true;
    }
    return false;
  }

  private buildNavigationGraph() {
    const { cols, rows } = this.map;
    const padR = getMoveCheckRadius(CHAR_BASE_RADIUS);
    const elevByTile = new Map<number, number>();
    this.navStandable.clear();
    this.navAdj.clear();
    this.wallCellKeys.clear();

    const markRectWalls = (rect: { x: number; y: number; w: number; h: number }) => {
      const gx0 = clamp(Math.floor(rect.x / TILE), 0, cols - 1);
      const gy0 = clamp(Math.floor(rect.y / TILE), 0, rows - 1);
      const gx1 = clamp(Math.floor((rect.x + rect.w - 0.01) / TILE), 0, cols - 1);
      const gy1 = clamp(Math.floor((rect.y + rect.h - 0.01) / TILE), 0, rows - 1);
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          this.wallCellKeys.add(`${gx},${gy}`);
        }
      }
    };
    for (const obs of this.map.obstacles) {
      if (obs.kind === 'wall') markRectWalls(obs);
    }
    for (const tree of this.map.trees) {
      markRectWalls(tree);
    }

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const cx = (gx + 0.5) * TILE;
        const cy = (gy + 0.5) * TILE;
        const elev = this.getWalkableElevation(cx, cy);
        if (this.canStandWithPadding(cx, cy, elev, CHAR_BASE_RADIUS) && !this.hasTreeTrunkNear(cx, cy, padR)) {
          const idx = this.tileIndex(gx, gy);
          this.navStandable.add(idx);
          elevByTile.set(idx, elev);
        }
      }
    }

    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const idx of this.navStandable) {
      const gx = idx % cols;
      const gy = Math.floor(idx / cols);
      const elevA = elevByTile.get(idx)!;
      const neighbors: number[] = [];

      for (const [ox, oy] of dirs) {
        const ngx = gx + ox;
        const ngy = gy + oy;
        if (ngx < 0 || ngx >= cols || ngy < 0 || ngy >= rows) continue;
        const nIdx = this.tileIndex(ngx, ngy);
        if (!this.navStandable.has(nIdx)) continue;
        const elevB = elevByTile.get(nIdx)!;
        if (Math.abs(elevA - elevB) > 0.5) continue;

        const midX = (gx + ox * 0.5 + 0.5) * TILE;
        const midY = (gy + oy * 0.5 + 0.5) * TILE;
        const midElev = this.getWalkableElevation(midX, midY);
        if (
          Math.abs(midElev - elevA) <= 0.5 &&
          Math.abs(midElev - elevB) <= 0.5 &&
          this.canStandWithPadding(midX, midY, midElev, CHAR_BASE_RADIUS) &&
          !this.hasTreeTrunkNear(midX, midY, padR)
        ) {
          neighbors.push(nIdx);
        }
      }
      this.navAdj.set(idx, neighbors);
    }
  }

  private isBlockedByAliveSiegeStructure(
    x: number,
    y: number,
    extraRadius = getMoveCheckRadius(CHAR_BASE_RADIUS)
  ): boolean {
    if (!this.siege) return false;
    for (const s of this.siege.structures) {
      if (s.alive && dist(x, y, s.x, s.y) < s.radius + extraRadius) {
        return true;
      }
    }
    return false;
  }

  private findNearestStandableTile(gx: number, gy: number, avoidStructures = false): number | null {
    const clampedX = clamp(gx, 0, this.map.cols - 1);
    const clampedY = clamp(gy, 0, this.map.rows - 1);
    const isBlocked = (tx: number, ty: number) =>
      avoidStructures && this.isBlockedByAliveSiegeStructure((tx + 0.5) * TILE, (ty + 0.5) * TILE);
    const direct = this.tileIndex(clampedX, clampedY);
    if (this.navStandable.has(direct) && !isBlocked(clampedX, clampedY)) return direct;

    let bestIdx: number | null = null;
    let bestD = Infinity;
    for (let r = 1; r <= 4; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const nx = clampedX + ox;
          const ny = clampedY + oy;
          if (nx < 0 || nx >= this.map.cols || ny < 0 || ny >= this.map.rows) continue;
          const idx = this.tileIndex(nx, ny);
          if (this.navStandable.has(idx) && !isBlocked(nx, ny)) {
            const d = Math.abs(ox) + Math.abs(oy);
            if (d < bestD) {
              bestD = d;
              bestIdx = idx;
            }
          }
        }
      }
      if (bestIdx !== null) return bestIdx;
    }
    return null;
  }

  /**
   * A* 尋路演算法（遵循 |Δh| <= 0.5 高度差、階梯、跨河橋樑與 1×N 隧道）
   */
  public findPathAStar(startX: number, startY: number, goalX: number, goalY: number): GridTile[] {
    const { cols } = this.map;
    const avoidStructures = Boolean(this.siege);
    const startIdx = this.findNearestStandableTile(Math.floor(startX / TILE), Math.floor(startY / TILE), avoidStructures);
    const goalIdx = this.findNearestStandableTile(Math.floor(goalX / TILE), Math.floor(goalY / TILE), avoidStructures);
    if (startIdx === null || goalIdx === null) return [];

    const goalGx = goalIdx % cols;
    const goalGy = Math.floor(goalIdx / cols);
    if (startIdx === goalIdx) return [{ gx: goalGx, gy: goalGy }];

    const openSet = new Set<number>([startIdx]);
    const cameFrom = new Map<number, number>();
    const gScore = new Map<number, number>([[startIdx, 0]]);
    const fScore = new Map<number, number>([
      [startIdx, Math.abs((startIdx % cols) - goalGx) + Math.abs(Math.floor(startIdx / cols) - goalGy)],
    ]);

    while (openSet.size > 0) {
      let current = -1;
      let bestF = Infinity;
      for (const idx of openSet) {
        const f = fScore.get(idx) ?? Infinity;
        if (f < bestF) {
          bestF = f;
          current = idx;
        }
      }
      if (current === -1) break;

      if (current === goalIdx) {
        const path: GridTile[] = [];
        let trace: number | undefined = current;
        while (trace !== undefined) {
          path.push({ gx: trace % cols, gy: Math.floor(trace / cols) });
          trace = cameFrom.get(trace);
        }
        path.reverse();
        return path;
      }

      openSet.delete(current);
      const curG = gScore.get(current) ?? Infinity;
      const curGx = current % cols;
      const curGy = Math.floor(current / cols);
      const curElev = this.getWalkableElevation((curGx + 0.5) * TILE, (curGy + 0.5) * TILE);

      for (const nxt of this.navAdj.get(current) || []) {
        const ngx = nxt % cols;
        const ngy = Math.floor(nxt / cols);
        if (avoidStructures) {
          const nxtCenterX = (ngx + 0.5) * TILE;
          const nxtCenterY = (ngy + 0.5) * TILE;
          const edgeMidX = ((curGx + ngx) * 0.5 + 0.5) * TILE;
          const edgeMidY = ((curGy + ngy) * 0.5 + 0.5) * TILE;
          if (
            this.isBlockedByAliveSiegeStructure(nxtCenterX, nxtCenterY) ||
            this.isBlockedByAliveSiegeStructure(edgeMidX, edgeMidY)
          ) {
            continue;
          }
        }
        const nxtElev = this.getWalkableElevation((ngx + 0.5) * TILE, (ngy + 0.5) * TILE);
        const stepCost = 1 + (Math.abs(nxtElev - curElev) > 0.01 ? 0.08 : 0);
        const tentativeG = curG + stepCost;
        if (tentativeG < (gScore.get(nxt) ?? Infinity)) {
          cameFrom.set(nxt, current);
          gScore.set(nxt, tentativeG);
          const h = Math.abs(ngx - goalGx) + Math.abs(ngy - goalGy);
          fScore.set(nxt, tentativeG + h);
          openSet.add(nxt);
        }
      }
    }
    return [];
  }

  private getActiveFactionCount(fac: FactionId): number {
    let count = this.player.faction === fac && this.player.hp > 0 ? 1 : 0;
    for (const e of this.enemies) {
      if (e.faction === fac) count += 1;
    }
    return count;
  }

  private pickBestDispersedSpawn(fac: FactionId): { x: number; y: number } {
    const spawns = this.map.factionSpawns[fac];
    if (!spawns || spawns.length === 0) {
      return { x: this.map.width / 2, y: this.map.height / 2 };
    }
    const activePositions: { x: number; y: number }[] = [];
    if (this.player.hp > 0) {
      activePositions.push({ x: this.player.x, y: this.player.y });
    }
    for (const e of this.enemies) {
      activePositions.push({ x: e.x, y: e.y });
    }
    if (activePositions.length === 0) {
      return spawns[Math.floor(Math.random() * spawns.length)];
    }
    let bestSp = spawns[0];
    let bestMinDist = -1;
    for (const sp of spawns) {
      let minD = Infinity;
      for (const pos of activePositions) {
        const d = dist(sp.x, sp.y, pos.x, pos.y);
        if (d < minD) minD = d;
      }
      if (minD > bestMinDist) {
        bestMinDist = minD;
        bestSp = sp;
      }
    }
    return bestSp;
  }

  private refillFieldUpToCap() {
    const factions: FactionId[] = ['royal', 'shadow', 'mercenary'];
    for (const fac of factions) {
      let reservedSlot = this.status === 'RESPAWNING' && this.player.faction === fac ? 1 : 0;
      for (const rt of this.remoteHumans.values()) {
        if (rt.faction === fac && rt.respawnTimer > 0) reservedSlot += 1;
      }
      while (this.deploymentQueue[fac] > 0 && this.getActiveFactionCount(fac) + reservedSlot < 2) {
        this.deploymentQueue[fac] -= 1;
        const sp = this.pickBestDispersedSpawn(fac);
        const isAlly = fac !== 'mercenary' && fac === this.player.faction;
        const arch = this.pickRandomArchetype();
        this.enemies.push(this.createEnemy(arch, fac, isAlly, sp.x + (Math.random() - 0.5) * 14, sp.y + (Math.random() - 0.5) * 14));
      }
    }
  }

  private checkVictoryCondition() {
    if (this.status !== 'PLAYING') return;
    if (this.multiplayer?.role === 'client') return;
    if (this.mode === 'siege') return;
    const p = this.player;

    if (this.multiplayer?.role === 'host') {
      const units: { id: string; faction: FactionId }[] = [];
      if (p.hp > 0 || p.lives > 0) {
        units.push({ id: 'player', faction: p.faction });
      }
      for (const e of this.enemies) {
        if (e.hp > 0) units.push({ id: e.id, faction: e.faction });
      }
      for (const rt of this.remoteHumans.values()) {
        if (rt.respawnTimer > 0 && !units.some((u) => u.id === rt.entityId)) {
          units.push({ id: rt.entityId, faction: rt.faction });
        }
      }
      for (const fac of ['royal', 'shadow', 'mercenary'] as FactionId[]) {
        for (let k = 0; k < this.deploymentQueue[fac]; k++) {
          units.push({ id: `queued_${fac}_${k}`, faction: fac });
        }
      }

      let anyHostilePair = false;
      for (let i = 0; i < units.length && !anyHostilePair; i++) {
        for (let j = i + 1; j < units.length; j++) {
          if (areHostile(units[i].faction, units[i].id, units[j].faction, units[j].id)) {
            anyHostilePair = true;
            break;
          }
        }
      }
      if (anyHostilePair) return;

      const hostSideSurvived =
        p.hp > 0 ||
        (p.faction !== 'mercenary' &&
          units.some((u) => u.faction === p.faction));
      this.status = hostSideSurvived ? 'VICTORY' : 'GAME_OVER';
      if (this.status === 'VICTORY') sfx.victory();
      else sfx.defeat();
      this.clearInputs();
      this.emitHud();
      return;
    }

    if (p.faction === 'mercenary') {
      const queuedLeft =
        this.deploymentQueue.royal + this.deploymentQueue.shadow + this.deploymentQueue.mercenary;
      if (this.enemies.length === 0 && queuedLeft === 0) {
        this.status = 'VICTORY';
        sfx.victory();
        this.clearInputs();
        this.emitHud();
      }
    } else {
      const others = (['royal', 'shadow', 'mercenary'] as FactionId[]).filter((f) => f !== p.faction);
      const activeHostiles = this.enemies.filter((e) => e.faction !== p.faction).length;
      const queuedHostiles = this.deploymentQueue[others[0]] + this.deploymentQueue[others[1]];
      if (activeHostiles === 0 && queuedHostiles === 0) {
        this.status = 'VICTORY';
        sfx.victory();
        this.clearInputs();
        this.emitHud();
      }
    }
  }

  public getWalkableElevation(x: number, y: number): number {
    const gx = clamp(Math.floor(x / TILE), 0, this.map.cols - 1);
    const gy = clamp(Math.floor(y / TILE), 0, this.map.rows - 1);
    let best = this.map.tileGrid[gy][gx].elev;
    for (const st of this.map.stairs) {
      if (pointInRect(x, y, st) && st.elevation > best) best = st.elevation;
    }
    for (const obs of this.map.obstacles) {
      if (pointInRect(x, y, obs) && obs.elevation > best) best = obs.elevation;
    }
    for (const blk of this.map.pushableIceBlocks || []) {
      if (pointInRect(x, y, blk) && blk.elevation > best) best = blk.elevation;
    }
    return best;
  }

  private isGroundWalkable(x: number, y: number): boolean {
    if (this.map.waterTileKeys.size === 0) return true;
    for (const b of this.map.bridges) {
      if (pointInRect(x, y, b)) return true;
    }
    const gx = Math.floor(x / TILE);
    const gy = Math.floor(y / TILE);
    const key = `${gx},${gy}`;
    if (!this.map.waterTileKeys.has(key)) return true;
    if (this.map.floatingIceTileKeys?.has(key)) return true;
    return Boolean(this.map.floatingIceTiles?.some((f) => f.gx === gx && f.gy === gy));
  }

  private findSafeTeleportSpot(
    targetX: number,
    targetY: number,
    approachAngle: number,
    offsetDist: number,
    radius: number,
    fallbackX: number,
    fallbackY: number
  ): { x: number; y: number } {
    const pad = radius + ELEV_PADDING;
    const isSpotValid = (cx: number, cy: number): boolean => {
      if (cx < pad || cx > this.map.width - pad || cy < pad || cy > this.map.height - pad) return false;
      if (!this.isGroundWalkable(cx, cy)) return false;
      for (const obs of this.map.obstacles) {
        if (
          (obs.kind === 'wall' || obs.style === 'railing') &&
          cx >= obs.x - pad &&
          cx <= obs.x + obs.w + pad &&
          cy >= obs.y - pad &&
          cy <= obs.y + obs.h + pad
        ) {
          return false;
        }
      }
      if (this.siege) {
        for (const s of this.siege.structures) {
          if (s.alive && dist(cx, cy, s.x, s.y) < s.radius + pad) {
            return false;
          }
        }
      }
      return true;
    };

    const candidateAngles = [
      approachAngle + Math.PI,
      approachAngle + Math.PI * 0.75,
      approachAngle - Math.PI * 0.75,
      approachAngle + Math.PI * 0.5,
      approachAngle - Math.PI * 0.5,
      approachAngle,
    ];
    for (const a of candidateAngles) {
      const cx = clamp(targetX + Math.cos(a) * offsetDist, pad, this.map.width - pad);
      const cy = clamp(targetY + Math.sin(a) * offsetDist, pad, this.map.height - pad);
      if (isSpotValid(cx, cy)) return { x: cx, y: cy };
    }
    if (isSpotValid(targetX, targetY)) return { x: targetX, y: targetY };
    return { x: fallbackX, y: fallbackY };
  }

  private getHeightAtPoint(x: number, y: number): {
    totalHeight: number;
    terrainHeight: number;
    isWall: boolean;
    isCrate: boolean;
  } {
    const gx = clamp(Math.floor(x / TILE), 0, this.map.cols - 1);
    const gy = clamp(Math.floor(y / TILE), 0, this.map.rows - 1);
    const tileElev = this.map.tileGrid[gy][gx].elev;

    for (const blk of this.map.pushableIceBlocks || []) {
      if (pointInRect(x, y, blk)) {
        return {
          totalHeight: blk.elevation,
          terrainHeight: tileElev,
          isWall: false,
          isCrate: true,
        };
      }
    }
    for (const obs of this.map.obstacles) {
      if (pointInRect(x, y, obs)) {
        return {
          totalHeight: obs.elevation,
          terrainHeight: obs.kind === 'crate' ? tileElev : obs.elevation,
          isWall: obs.kind === 'wall',
          isCrate: obs.kind === 'crate',
        };
      }
    }
    for (const tree of this.map.trees) {
      if (pointInRect(x, y, tree)) {
        const treeHeight = Math.max(10, Math.round((tileElev + 10) * 10) / 10);
        return {
          totalHeight: treeHeight,
          terrainHeight: treeHeight,
          isWall: true,
          isCrate: false,
        };
      }
    }
    const terrain = this.getWalkableElevation(x, y);
    return { totalHeight: terrain, terrainHeight: terrain, isWall: false, isCrate: false };
  }

  private clampCameraToMap(camX: number, camY: number, canvasWidth: number, canvasHeight: number) {
    const zoom = Math.max(0.5, this.camera.zoom);
    const halfW = canvasWidth / (2 * zoom);
    const halfH = canvasHeight / (2 * zoom);
    const x =
      halfW * 2 >= this.map.width
        ? this.map.width / 2
        : clamp(camX, halfW, this.map.width - halfW);
    const y =
      halfH * 2 >= this.map.height
        ? this.map.height / 2
        : clamp(camY, halfH, this.map.height - halfH);
    return { x, y };
  }

  /**
   * 移動檢查：
   * - 角色直徑 = 1 格 (radius = 0.5 格)
   * - 無法跨越的地形高度差 (|Δh| > 0.5) 或河道水域保留 0.1 格 padding
   */
  private countElevationViolations(x: number, y: number, curElev: number, hitRadius: number): number {
    const checkR = getMoveCheckRadius(hitRadius);
    let violations = 0;
    if (x < checkR || x > this.map.width - checkR || y < checkR || y > this.map.height - checkR) {
      violations += 4;
    }
    if (!this.isGroundWalkable(x, y)) violations += 4;
    const centerElev = this.getWalkableElevation(x, y);
    if (Math.abs(centerElev - curElev) > 0.5) violations += 4;

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const sx = x + Math.cos(a) * checkR;
      const sy = y + Math.sin(a) * checkR;
      if (!this.isGroundWalkable(sx, sy)) {
        violations += 1;
      } else {
        const se = this.getWalkableElevation(sx, sy);
        if (Math.abs(se - curElev) > 0.5) violations += 1;
      }
    }
    for (const obs of this.map.obstacles) {
      if (obs.kind === 'wall' || obs.style === 'railing') {
        const res = resolveCircleRect(x, y, checkR, obs);
        if (res.hit) violations += 2;
      }
    }
    for (const tree of this.map.trees) {
      const res = resolveCircleRect(x, y, checkR, tree);
      if (res.hit) violations += 2;
    }
    return violations;
  }

  private canStandWithPadding(x: number, y: number, curElev: number, hitRadius: number): boolean {
    return this.countElevationViolations(x, y, curElev, hitRadius) === 0;
  }

  private moveCharacterWithElevation(
    curX: number,
    curY: number,
    curElev: number,
    dx: number,
    dy: number,
    hitRadius: number
  ): { x: number; y: number; elevation: number } {
    const padRadius = getMoveCheckRadius(hitRadius);
    const curViolations = this.countElevationViolations(curX, curY, curElev, hitRadius);

    let nx = curX + dx;
    let ny = curY;
    const xViolations = this.countElevationViolations(nx, ny, curElev, hitRadius);
    if (xViolations > 0 && (curViolations === 0 || xViolations > curViolations || Math.abs(this.getWalkableElevation(nx, ny) - curElev) > 0.5)) {
      nx = curX;
      // 1×N 隧道／狹道入口自動對齊輔助（水平撞角時微調 Y 軸對齊格心）
      if (Math.abs(dx) > 0.01 && Math.abs(dy) <= Math.abs(dx) * 0.25) {
        const centerY = (Math.floor(curY / TILE) + 0.5) * TILE;
        const diffY = centerY - curY;
        if (Math.abs(diffY) > 0.4 && Math.abs(diffY) <= TILE * 0.48) {
          if (this.countElevationViolations(curX + dx, centerY, curElev, hitRadius) === 0) {
            const stepY = Math.sign(diffY) * Math.min(Math.abs(diffY), Math.abs(dx) * 1.15);
            const nudgedY = curY + stepY;
            if (this.countElevationViolations(curX, nudgedY, curElev, hitRadius) === 0) {
              ny = nudgedY;
              if (this.countElevationViolations(curX + dx, ny, curElev, hitRadius) === 0) {
                nx = curX + dx;
              }
            }
          }
        }
      }
    }

    const elevBeforeY = this.getWalkableElevation(nx, ny);
    const desiredY = ny + dy;
    const yBaseViolations = this.countElevationViolations(nx, ny, elevBeforeY, hitRadius);
    const yViolations = this.countElevationViolations(nx, desiredY, elevBeforeY, hitRadius);
    if (yViolations > 0 && (yBaseViolations === 0 || yViolations > yBaseViolations || Math.abs(this.getWalkableElevation(nx, desiredY) - elevBeforeY) > 0.5)) {
      // 1×N 隧道／狹道入口自動對齊輔助（垂直撞角時微調 X 軸對齊格心）
      if (Math.abs(dy) > 0.01 && Math.abs(dx) <= Math.abs(dy) * 0.25 && nx === curX) {
        const centerX = (Math.floor(curX / TILE) + 0.5) * TILE;
        const diffX = centerX - curX;
        if (Math.abs(diffX) > 0.4 && Math.abs(diffX) <= TILE * 0.48) {
          if (this.countElevationViolations(centerX, curY + dy, curElev, hitRadius) === 0) {
            const stepX = Math.sign(diffX) * Math.min(Math.abs(diffX), Math.abs(dy) * 1.15);
            const nudgedX = curX + stepX;
            if (this.countElevationViolations(nudgedX, curY, curElev, hitRadius) === 0) {
              nx = nudgedX;
              if (this.countElevationViolations(nx, curY + dy, curElev, hitRadius) === 0) {
                ny = curY + dy;
              }
            }
          }
        }
      }
    } else {
      ny = desiredY;
    }

    // 不可跨越石牆、防護欄杆與樹幹同樣保留通道間距
    for (const obs of this.map.obstacles) {
      if (obs.kind === 'wall' || obs.style === 'railing') {
        const res = resolveCircleRect(nx, ny, padRadius, obs);
        nx = res.x;
        ny = res.y;
      }
    }

    for (const tree of this.map.trees) {
      const res = resolveCircleRect(nx, ny, padRadius, tree);
      nx = res.x;
      ny = res.y;
    }

    if (this.siege) {
      for (const s of this.siege.structures) {
        if (!s.alive) continue;
        const dx = nx - s.x;
        const dy = ny - s.y;
        const minD = s.radius + padRadius;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD * minD) {
          const d = Math.sqrt(d2) || 0.001;
          nx = s.x + (dx / d) * minD;
          ny = s.y + (dy / d) * minD;
        }
      }
    }

    nx = clamp(nx, padRadius, this.map.width - padRadius);
    ny = clamp(ny, padRadius, this.map.height - padRadius);

    const finalElev = this.getWalkableElevation(nx, ny);
    if (Math.abs(finalElev - curElev) > 0.5) {
      return { x: curX, y: curY, elevation: curElev };
    }
    return { x: nx, y: ny, elevation: finalElev };
  }

  private isSolidWallCell(gx: number, gy: number): boolean {
    if (gx < 0 || gx >= this.map.cols || gy < 0 || gy >= this.map.rows) return false;
    return this.wallCellKeys.has(`${gx},${gy}`);
  }

  private findEarliestWallHit(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): { t: number; x: number; y: number } | null {
    let best: { t: number; x: number; y: number } | null = null;
    for (const obs of this.map.obstacles) {
      if (obs.kind !== 'wall') continue;
      const res = segmentIntersectsRect(x1, y1, x2, y2, obs);
      if (res.hit && (!best || res.t < best.t)) {
        best = { t: res.t, x: res.hitX, y: res.hitY };
      }
    }
    for (const tree of this.map.trees) {
      const res = segmentIntersectsRect(x1, y1, x2, y2, tree);
      if (res.hit && (!best || res.t < best.t)) {
        best = { t: res.t, x: res.hitX, y: res.hitY };
      }
    }
    return best;
  }

  /**
   * 視線檢查 (LoS)：視野半徑 ~8 格，若隔實心牆（含對角相接牆縫）或離開較高一方自身站台後被遮蔽物擋住 3D 直線視線則看不到；
   * 統一由較高一端往較低一端步進，保證雙方視線對稱且不會因站得高而無視空地後方的大箱／高台。
   */
  private hasLineOfSight(
    ax: number,
    ay: number,
    aElev: number,
    bx: number,
    by: number,
    bElev: number,
    maxRange: number
  ): boolean {
    const totalD = dist(ax, ay, bx, by);
    if (totalD > maxRange) return false;
    if (this.findEarliestWallHit(ax, ay, bx, by)) return false;

    const aIsHigher = aElev >= bElev;
    const sx = aIsHigher ? ax : bx;
    const sy = aIsHigher ? ay : by;
    const sElev = aIsHigher ? aElev : bElev;
    const ex = aIsHigher ? bx : ax;
    const ey = aIsHigher ? by : ay;
    const eElev = aIsHigher ? bElev : aElev;

    const steps = Math.max(2, Math.ceil(totalD / 6));
    let prevGx = clamp(Math.floor(sx / TILE), 0, this.map.cols - 1);
    let prevGy = clamp(Math.floor(sy / TILE), 0, this.map.rows - 1);
    let leftHighPlatform = false;

    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = sx + (ex - sx) * t;
      const py = sy + (ey - sy) * t;
      const curGx = clamp(Math.floor(px / TILE), 0, this.map.cols - 1);
      const curGy = clamp(Math.floor(py / TILE), 0, this.map.rows - 1);
      if (
        curGx !== prevGx &&
        curGy !== prevGy &&
        this.isSolidWallCell(curGx, prevGy) &&
        this.isSolidWallCell(prevGx, curGy)
      ) {
        return false;
      }
      prevGx = curGx;
      prevGy = curGy;
      const h = this.getHeightAtPoint(px, py);
      if (h.isWall) return false;
      if (h.totalHeight < sElev - 0.01) {
        leftHighPlatform = true;
      }
      if (h.totalHeight > sElev + 1.0) return false;
      if (leftHighPlatform) {
        const rayElev = sElev + (eElev - sElev) * t;
        if (h.totalHeight > rayElev + 1.0) return false;
      }
    }
    return true;
  }

  /**
   * 檢查目前站位與高低差下，遠程子彈是否確實射得到目標（而非被 > 1 格高低差或途中遮蔽箱體擋住）
   */
  private canRangedHitTarget(
    ax: number,
    ay: number,
    aElev: number,
    bx: number,
    by: number,
    bElev: number
  ): boolean {
    if (bElev - aElev >= 2.0) return false;
    const totalD = dist(ax, ay, bx, by);
    if (totalD <= 18) return true;
    const seg = this.traceBulletSegment(ax, ay, Math.atan2(by - ay, bx - ax), totalD, aElev, false);
    const reachedDist = dist(ax, ay, seg.x2, seg.y2);
    if (reachedDist < totalD - 20) return false;
    return bElev - seg.elevAt(Math.min(reachedDist, totalD)) < 2.0;
  }

  /**
   * 搜尋附近 5×5 格內戰術優勢站位：
   * - 優先選擇「能射到敵人但敵人打不到自己」的單向掩體／高低差位置
   * - 佔據高地時拒絕往低層移動
   */
  private findBestTacticalSpot(
    e: EnemyEntity,
    target: { x: number; y: number; elev: number },
    sightRange: number,
    desiredRange: number,
    holdingHighGround: boolean,
    isReloading: boolean
  ): { x: number; y: number; scoreGain: number; oneWayAdvantage: boolean; isCurrentTile: boolean } | null {
    const { cols, rows } = this.map;
    const curGx = clamp(Math.floor(e.x / TILE), 0, cols - 1);
    const curGy = clamp(Math.floor(e.y / TILE), 0, rows - 1);

    const evalPoint = (px: number, py: number, elev: number) => {
      const d = dist(px, py, target.x, target.y);
      if (d > sightRange * 0.96) return null;
      if (!this.hasLineOfSight(px, py, elev, target.x, target.y, target.elev, sightRange)) return null;
      const aiCanHit = this.canRangedHitTarget(px, py, elev, target.x, target.y, target.elev);
      const targetCanHit = this.canRangedHitTarget(target.x, target.y, target.elev, px, py, elev);
      const oneWayAdvantage = aiCanHit && !targetCanHit;
      let score = 0;
      if (isReloading) {
        score += !targetCanHit ? 160 : -40;
      } else {
        if (!aiCanHit) return null;
        if (oneWayAdvantage) score += 140;
      }
      if (elev > target.elev) {
        score += 45 * (elev - target.elev);
      }
      score -= Math.abs(d - desiredRange) * 0.14;
      score -= dist(e.x, e.y, px, py) * 0.08;
      return { score, oneWayAdvantage };
    };

    const curEval = evalPoint(e.x, e.y, e.elevation);
    const curScore = curEval ? curEval.score : -999;
    let best: { x: number; y: number; score: number; oneWayAdvantage: boolean; isCurrentTile: boolean } | null = curEval
      ? { x: e.x, y: e.y, score: curScore, oneWayAdvantage: curEval.oneWayAdvantage, isCurrentTile: true }
      : null;

    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const gx = curGx + dx;
        const gy = curGy + dy;
        if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) continue;
        const idx = this.tileIndex(gx, gy);
        if (!this.navStandable.has(idx)) continue;
        const cx = (gx + 0.5) * TILE;
        const cy = (gy + 0.5) * TILE;
        const candElev = this.getWalkableElevation(cx, cy);
        if (holdingHighGround && candElev < e.elevation - 0.01) continue;
        if (Math.abs(candElev - e.elevation) > 1.0) continue;

        const res = evalPoint(cx, cy, candElev);
        if (!res) continue;
        if (!best || res.score > best.score) {
          best = { x: cx, y: cy, score: res.score, oneWayAdvantage: res.oneWayAdvantage, isCurrentTile: false };
        }
      }
    }

    if (!best) return null;
    return {
      x: best.x,
      y: best.y,
      scoreGain: best.score - curScore,
      oneWayAdvantage: best.oneWayAdvantage,
      isCurrentTile: best.isCurrentTile,
    };
  }

  /**
   * 子彈射線高度阻擋物理（單調下降高度模型）：
   * - 子彈以 startElev 出發，可越過 Δh <= 1.0 的低矮掩體（小木箱／欄杆）而不會抬升高度
   * - 一旦經過較矮地形或箱體表面，bulletElev 會永久降至該表面高度，之後不可再爬升回原本高度
   * - 高度差 > 1.0 且 < 2.0（如大箱子）：子彈深入邊緣約 0.5 格處停止
   * - 高度差 >= 2.0 格（如貨櫃、2層山、實牆）：子彈在邊緣即停止（0 穿透）
   */
  private traceBulletSegment(
    x1: number,
    y1: number,
    angle: number,
    maxDist: number,
    startElev: number,
    emitBurst = true
  ): { x1: number; y1: number; x2: number; y2: number; endElev: number; elevAt: (distFromStart: number) => number } {
    const stepSize = 4;
    let curX = x1;
    let curY = y1;
    const vx = Math.cos(angle);
    const vy = Math.sin(angle);
    const wallHit = this.findEarliestWallHit(x1, y1, x1 + vx * maxDist, y1 + vy * maxDist);
    const wallDist = wallHit ? dist(x1, y1, wallHit.x, wallHit.y) : maxDist;
    const effectiveMaxDist = Math.min(maxDist, wallDist);
    let bulletElev = startElev;
    const elevDrops: { dist: number; elev: number }[] = [{ dist: 0, elev: startElev }];
    const elevAt = (distFromStart: number): number => {
      let e = startElev;
      for (const drop of elevDrops) {
        if (drop.dist <= distFromStart) e = drop.elev;
        else break;
      }
      return e;
    };
    const buildResult = (x2: number, y2: number) => ({
      x1,
      y1,
      x2,
      y2,
      endElev: bulletElev,
      elevAt,
    });
    let remaining = effectiveMaxDist;
    let traveled = 0;
    let penetratingHalfTile = false;
    let penetrationLeft = TILE * 0.49;

    while (remaining > 0) {
      const prevX = curX;
      const prevY = curY;
      const prevGx = clamp(Math.floor(prevX / TILE), 0, this.map.cols - 1);
      const prevGy = clamp(Math.floor(prevY / TILE), 0, this.map.rows - 1);
      const step = Math.min(stepSize, remaining);
      curX += vx * step;
      curY += vy * step;
      remaining -= step;
      traveled += step;

      if (curX < 0 || curX > this.map.width || curY < 0 || curY > this.map.height) {
        return buildResult(clamp(curX, 0, this.map.width), clamp(curY, 0, this.map.height));
      }

      const curGx = clamp(Math.floor(curX / TILE), 0, this.map.cols - 1);
      const curGy = clamp(Math.floor(curY / TILE), 0, this.map.rows - 1);
      if (
        curGx !== prevGx &&
        curGy !== prevGy &&
        this.isSolidWallCell(curGx, prevGy) &&
        this.isSolidWallCell(prevGx, curGy)
      ) {
        if (emitBurst) this.spawnBurst(prevX, prevY, '#E2E8F0', 4);
        return buildResult(prevX, prevY);
      }

      const h = this.getHeightAtPoint(curX, curY);
      if (!h.isWall && !penetratingHalfTile) {
        const rawSurface = h.isCrate ? h.totalHeight : h.terrainHeight;
        const effectiveSurface = startElev < 0 ? rawSurface : Math.max(0, rawSurface);
        if (effectiveSurface < bulletElev) {
          bulletElev = effectiveSurface;
          elevDrops.push({ dist: traveled, elev: bulletElev });
        }
      }

      const heightDiff = h.totalHeight - bulletElev;
      if (h.isWall || heightDiff >= 2.0) {
        if (emitBurst) this.spawnBurst(prevX, prevY, '#E2E8F0', 4);
        return buildResult(prevX, prevY);
      }

      const blocksHalfTile = heightDiff > 1.0;
      if (penetratingHalfTile) {
        if (!blocksHalfTile) {
          // Exited the narrow 1.5 ridge cleanly
          penetratingHalfTile = false;
          penetrationLeft = TILE * 0.49;
          continue;
        }
        penetrationLeft -= step;
        if (penetrationLeft <= 0) {
          if (emitBurst) this.spawnBurst(curX, curY, '#E2E8F0', 4);
          return buildResult(curX, curY);
        }
      } else if (blocksHalfTile) {
        // 高度差 > 1.0 且 < 2.0（例如 1.5 格大箱）：深入邊緣約 0.5 格後才停下
        penetratingHalfTile = true;
        penetrationLeft -= step;
        if (penetrationLeft <= 0) {
          if (emitBurst) this.spawnBurst(curX, curY, '#E2E8F0', 4);
          return buildResult(curX, curY);
        }
      }
    }

    if (wallHit && wallDist <= maxDist) {
      if (emitBurst) this.spawnBurst(wallHit.x, wallHit.y, '#E2E8F0', 4);
      return buildResult(wallHit.x, wallHit.y);
    }

    return buildResult(curX, curY);
  }

  private spawnMapWeapons() {
    for (const ws of this.map.weaponSpawns) {
      if (ws.kind === 'gun') {
        const gunDef = GUNS.find((g) => g.id === ws.weaponId);
        if (gunDef) {
          this.pickups.push({
            id: uid('mapgun'),
            x: ws.x,
            y: ws.y,
            kind: 'gun',
            label: gunDef.name,
            color: gunDef.color,
            gunDef,
            ammoInMag: gunDef.magSize,
            bobPhase: Math.random() * 6,
          });
        }
      } else {
        const meleeDef = MELEES.find((m) => m.id === ws.weaponId);
        if (meleeDef) {
          this.pickups.push({
            id: uid('mapmelee'),
            x: ws.x,
            y: ws.y,
            kind: 'melee',
            label: meleeDef.name,
            color: meleeDef.color,
            meleeDef,
            bobPhase: Math.random() * 6,
          });
        }
      }
    }
  }

  private spawnMapAmmoPickups() {
    this.map.ammoSpawns.forEach((as, idx) => {
      as.active = true;
      as.respawnTimer = 0;
      this.pickups.push({
        id: uid('ammo_pad'),
        x: as.x,
        y: as.y,
        kind: 'ammo',
        label: '彈藥箱 (+30發)',
        color: '#60A5FA',
        amount: 30,
        bobPhase: Math.random() * 6,
        ammoSpawnIndex: idx,
      });
    });
  }

  private spawnMapShieldPickups() {
    const shieldDef = MELEES.find((m) => m.kind === 'shield');
    if (!shieldDef) return;
    this.map.shieldSpawns.forEach((ss) => {
      ss.active = true;
      ss.respawnTimer = 0;
      this.pickups.push({
        id: uid('mapshield'),
        x: ss.x,
        y: ss.y,
        kind: 'melee',
        label: shieldDef.name,
        color: shieldDef.color,
        meleeDef: shieldDef,
        durability: 100,
        bobPhase: 0,
      });
    });
  }

  public showBanner(text: string, duration = 2.8) {
    this.bannerText = text;
    this.bannerTimer = duration;
  }

  public setKey(code: string, pressed: boolean) {
    if (this.status === 'VICTORY' || this.status === 'GAME_OVER') {
      if (!pressed) this.keys.delete(code);
      return;
    }
    if (pressed) {
      if (!this.keys.has(code)) {
        this.keys.add(code);
        if (this.isSpectating() && code === 'Space') {
          this.cycleSpectatorTarget();
          return;
        }
        this.handleKeyDownOnce(code);
      }
    } else {
      this.keys.delete(code);
    }
  }

  public clearInputs() {
    this.keys.clear();
    this.mouseDown = false;
    this.cancelMeleeCharge(false);
  }

  private cancelMeleeCharge(refundAbortedQi = true) {
    if (refundAbortedQi && this.player.chargingMelee && !this.player.chargeReady && this.player.freezeTimer <= 0) {
      this.qiFastRefund = true;
    }
    this.player.chargingMelee = false;
    this.player.chargeReady = false;
    this.chargeSessionAllowed = false;
    this.meleeHeldSeconds = 0;
    sfx.setMeleeCharge(null);
  }

  public setMousePos(x: number, y: number) {
    const moveDist = dist(this.mouseScreen.x, this.mouseScreen.y, x, y);
    this.mouseScreen.x = x;
    this.mouseScreen.y = y;

    if (this.multiplayer?.role === 'client') {
      if (this.status === 'PLAYING') {
        const ptr = this.getWorldPointer();
        this.player.angle = Math.atan2(ptr.y - this.player.y, ptr.x - this.player.x);
      }
      return;
    }

    const weapon = this.player.weapons[this.player.activeHand];
    if (this.status === 'PLAYING' && weapon.type === 'gun') {
      const gun = weapon.def;
      if (gun.kind === 'sniper') {
        const delta = Math.max(0, moveDist - SNIPER_AIM.pointerDeadzonePx) * SNIPER_AIM.pointerMoveScale;
        if (delta > 0) {
          this.crosshairBloom = Math.min(
            gun.maxCrosshair - gun.baseCrosshair,
            this.crosshairBloom + Math.min(SNIPER_AIM.pointerMoveStepCap, delta)
          );
          this.crosshairBloomDelay = SNIPER_AIM.settleDelaySeconds;
        }
      } else {
        this.crosshairBloom = Math.min(
          gun.maxCrosshair - gun.baseCrosshair,
          this.crosshairBloom + Math.min(18, Math.max(0, moveDist - 2) * 0.09)
        );
      }
    }
    if (this.status === 'PLAYING') {
      const { x, y } = this.getWorldPointer();
      this.player.angle = Math.atan2(y - this.player.y, x - this.player.x);
    }
  }

  public setMouseDown(down: boolean) {
    if (this.status === 'VICTORY' || this.status === 'GAME_OVER') {
      this.mouseDown = false;
      return;
    }
    if (this.isSpectating()) {
      if (down && !this.mouseDown) {
        this.cycleSpectatorTarget();
      }
      this.mouseDown = down;
      return;
    }
    if (this.multiplayer?.role === 'client') {
      this.mouseDown = this.status === 'PLAYING' ? down : false;
      return;
    }
    if (this.status !== 'PLAYING') {
      this.mouseDown = false;
      return;
    }
    const weapon = this.player.weapons[this.player.activeHand];
    if (down && !this.mouseDown) {
      this.mouseDown = true;
      if (weapon.type === 'melee') {
        this.performMeleeAttack();
        if (this.mouseDown && this.status === 'PLAYING') {
          if (this.player.freezeTimer > 0) {
            this.player.chargingMelee = false;
            this.chargeSessionAllowed = false;
            this.player.chargeReady = false;
          } else if (
            this.mode === 'siege' &&
            this.siege &&
            weapon.def.kind !== 'shield' &&
            this.siege.playerState.level < SIEGE_CONFIG.ultimateUnlockLevel
          ) {
            this.player.chargingMelee = false;
            this.chargeSessionAllowed = false;
            this.player.chargeReady = false;
            if (this.player.qi >= this.player.maxQi - 0.5) {
              this.spawnText(
                this.player.x,
                this.player.y - 36,
                `Lv.${SIEGE_CONFIG.ultimateUnlockLevel} 解鎖近戰集氣大招`,
                '#94A3B8',
                0.85,
                true
              );
            }
          } else {
            this.chargeSessionAllowed = this.player.qi >= this.player.maxQi - 0.5;
          }
        }
      } else {
        if (this.player.swapTimer <= 0 && weapon.ammoInMag <= 0 && weapon.reloadTimer === 0) {
          this.startReload();
        } else {
          this.tryAttack();
        }
      }
    } else if (!down && this.mouseDown) {
      this.mouseDown = false;
      const dischargedReadyUlt = weapon.type === 'melee' && this.player.chargeReady;
      if (dischargedReadyUlt) {
        this.performMeleeAttack();
      }
      this.cancelMeleeCharge(!dischargedReadyUlt);
    }
  }

  private handleKeyDownOnce(code: string) {
    if (this.multiplayer?.role === 'client') return;
    if (code === 'KeyP') {
      if (this.status === 'PLAYING') {
        this.status = 'PAUSED';
        this.clearInputs();
        this.emitHud();
      } else if (this.status === 'PAUSED') {
        this.status = 'PLAYING';
        this.emitHud();
      }
      return;
    }

    if (this.status !== 'PLAYING') {
      if (this.mode === 'siege' && this.status === 'RESPAWNING') {
        if (code === 'Digit3') this.buySiegeUpgrade('firepower');
        else if (code === 'Digit4') this.buySiegeUpgrade('blade');
        else if (code === 'Digit5') this.buySiegeUpgrade('armor');
        else if (code === 'Digit6') this.buySiegeUpgrade('core');
      }
      return;
    }

    if (this.mode === 'siege') {
      if (code === 'KeyE') {
        this.triggerSiegeTactical();
        return;
      }
      if (code === 'KeyF') {
        this.triggerSiegeUltimate();
        return;
      }
      if (code === 'KeyB') {
        this.startSiegeRecall();
        return;
      }
      if (code === 'Digit3') {
        this.buySiegeUpgrade('firepower');
        return;
      }
      if (code === 'Digit4') {
        this.buySiegeUpgrade('blade');
        return;
      }
      if (code === 'Digit5') {
        this.buySiegeUpgrade('armor');
        return;
      }
      if (code === 'Digit6') {
        this.buySiegeUpgrade('core');
        return;
      }
      if (code === 'Escape' || code === 'Space') {
        return;
      }
    }

    if (code === 'Escape') {
      this.dropActiveWeapon();
    } else if (code === 'KeyQ') {
      this.switchWeapon();
    } else if (code === 'KeyR') {
      this.startReload();
    } else if (code === 'Space') {
      this.tryPickup();
    }
  }

  private dropWeapon(weapon: EquippedWeapon, x: number, y: number): boolean {
    if (weapon.def.kind === 'pistol' || weapon.def.kind === 'knife') return false;
    if (weapon.def.kind === 'shield' && weapon.type === 'melee' && weapon.durability <= 0) return false;

    this.pickups.push({
      id: uid(weapon.type === 'gun' ? 'dropgun' : 'dropmelee'),
      x,
      y,
      kind: weapon.type,
      label: weapon.def.name,
      color: weapon.def.color,
      ...(weapon.type === 'gun'
        ? { gunDef: weapon.def, ammoInMag: weapon.ammoInMag }
        : { meleeDef: weapon.def, durability: weapon.def.kind === 'shield' ? Math.round(weapon.durability) : undefined }),
      bobPhase: 0,
    });
    return true;
  }

  public dropActiveWeapon() {
    const p = this.player;
    if (p.hp <= 0) return;
    const weapon = p.weapons[p.activeHand];
    if (weapon.def.kind === 'pistol' || weapon.def.kind === 'knife') {
      this.spawnText(p.x, p.y - 36, `預設${weapon.def.name}無法放下`, '#94A3B8', 0.9);
      return;
    }

    this.dropWeapon(weapon, p.x, p.y);
    const fallback = defaultWeaponForHand(p.activeHand);
    p.weapons[p.activeHand] = fallback;
    this.cancelMeleeCharge();
    p.swapDuration = getWeaponSwapDuration(fallback.def.kind);
    p.swapTimer = p.swapDuration;
    this.resetGunFeedback();
    sfx.switchWeapon(false);
    this.spawnText(p.x, p.y - 38, `放下 ${weapon.def.name} · 換回${fallback.def.name}`, '#FBBF24', 1.05);
    this.emitHud();
  }

  private resetGunFeedback() {
    this.crosshairBloom = 0;
    this.crosshairBloomDelay = 0;
    this.rifleRecoilAngle = 0;
    this.player.gunfireTimer = 0;
  }

  private getWorldPointer() {
    return {
      x: (this.mouseScreen.x - this.viewport.width / 2) / this.camera.zoom + this.camera.x,
      y: (this.mouseScreen.y - this.viewport.height / 2) / this.camera.zoom + this.camera.y,
    };
  }

  private getPlayerGunSpread(gun: GunDef) {
    const p = this.player;
    const pointer = this.getWorldPointer();
    let focus = p.eagleEyeTimer > 0 ? RIFLE_RECOIL.eagleEyeMultiplier : 1;
    if (this.siege?.playerState.loadout.passiveId === 'royal_steady_aim') {
      focus *= 0.75;
    }
    return getGunSpread(
      gun.kind,
      gun.baseCrosshair + this.crosshairBloom,
      dist(p.x, p.y, pointer.x, pointer.y),
      focus
    );
  }

  private getPlayerRifleDrift() {
    return this.rifleRecoilAngle * (this.player.eagleEyeTimer > 0 ? RIFLE_RECOIL.eagleEyeMultiplier : 1);
  }

  public switchWeapon() {
    const p = this.player;
    this.cancelMeleeCharge();
    const prevWeapon = p.weapons[p.activeHand];
    if (prevWeapon.type === 'gun') {
      prevWeapon.reloadTimer = 0;
    }
    p.activeHand = p.activeHand === 0 ? 1 : 0;
    this.resetGunFeedback();
    const weapon = p.weapons[p.activeHand];
    const baseSwapDur = getWeaponSwapDuration(weapon.def.kind);
    const sinceAttack = this.time - p.lastAttackAt;
    if (p.delayCancelReady && sinceAttack <= 0.34 && sinceAttack >= 0.02) {
      p.attackCooldown = 0;
      p.delayCancelReady = false;
      p.comboEmpowerTimer = 1.6;
      p.swapDuration = baseSwapDur * 0.45;
      p.swapTimer = p.swapDuration;
      sfx.switchWeapon(true);
      this.spawnText(p.x, p.y - 36, 'Q 取消硬直 · 連攜增傷!', '#FBBF24', 1.15);
    } else {
      p.swapDuration = baseSwapDur;
      p.swapTimer = baseSwapDur;
      p.attackCooldown = Math.max(p.attackCooldown, baseSwapDur);
      sfx.switchWeapon(false);
    }
    this.emitHud();
  }

  public startReload() {
    const p = this.player;
    const weapon = p.weapons[p.activeHand];
    if (weapon.type !== 'gun' || weapon.reloadTimer > 0) return;
    if (weapon.ammoInMag >= weapon.def.magSize) {
      this.spawnText(p.x, p.y - 36, '彈匣已滿', '#94A3B8', 0.9);
      return;
    }
    if (p.reserveAmmo <= 0) {
      sfx.emptyGun();
      return;
    }
    let reloadMult = 1;
    if (this.siege) {
      const ps = this.siege.playerState;
      reloadMult = getSiegeGunProfile(weapon.def.kind).reloadMult;
      reloadMult -= (ps.upgrades.firepower ?? 0) * 0.06;
      if (ps.loadout.passiveId === 'royal_steady_aim') reloadMult -= 0.15;
      reloadMult = Math.max(0.45, reloadMult);
    }
    weapon.reloadTimer = weapon.def.reloadTime * reloadMult;
    sfx.reload(weapon.def.kind, 'start');
    this.spawnText(p.x, p.y - 36, '裝填彈藥中...', '#FBBF24', 0.95);
    this.emitHud();
  }

  public tryPickup() {
    const p = this.player;
    let bestIdx = -1;
    let bestD = 70;
    for (let i = 0; i < this.pickups.length; i++) {
      const d = dist(p.x, p.y, this.pickups[i].x, this.pickups[i].y);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return;

    const item = this.pickups[bestIdx];
    if (
      item.kind === 'ammo' &&
      p.reserveAmmo >= p.maxReserveAmmo &&
      p.weapons.every((weapon) => weapon.type !== 'gun' || weapon.ammoInMag >= weapon.def.magSize)
    ) {
      this.spawnText(p.x, p.y - 36, '彈藥已達上限 (45 發)', '#94A3B8', 0.95);
      return;
    }

    this.pickups.splice(bestIdx, 1);
    sfx.pickup();

    if (item.kind === 'ammo') {
      const added = item.amount || 30;
      p.reserveAmmo = Math.min(p.maxReserveAmmo, p.reserveAmmo + added);
      this.spawnText(p.x, p.y - 36, `+${added} 備彈 (目前 ${p.reserveAmmo}/45)`, '#60A5FA', 1.05);
      if (item.ammoSpawnIndex !== undefined) {
        const pad = this.map.ammoSpawns[item.ammoSpawnIndex];
        if (pad) {
          pad.active = false;
          pad.respawnTimer = 10.0;
        }
      }
    } else {
      let weapon: EquippedWeapon;
      if (item.kind === 'gun' && item.gunDef) {
        weapon = equipGun(item.gunDef, item.ammoInMag ?? item.gunDef.magSize);
      } else if (item.kind === 'melee' && item.meleeDef) {
        weapon = {
          type: 'melee',
          def: item.meleeDef,
          durability: item.meleeDef.kind === 'shield' ? clamp(item.durability ?? p.maxShield, 1, p.maxShield) : 0,
        };
      } else {
        return;
      }

      this.dropWeapon(p.weapons[p.activeHand], item.x, item.y);
      p.weapons[p.activeHand] = weapon;
      this.cancelMeleeCharge();
      this.resetGunFeedback();
      const label =
        weapon.type === 'gun'
          ? `${weapon.def.name} (${weapon.ammoInMag}/${weapon.def.magSize})`
          : weapon.def.kind === 'shield'
            ? `${weapon.def.name} (${Math.round(weapon.durability)}/100)`
            : weapon.def.name;
      this.spawnText(p.x, p.y - 38, `拾取 ${label}`, weapon.def.color, 1.15);
    }
    this.emitHud();
  }

  private getMoveVector() {
    let mx = 0;
    let my = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    const len = Math.hypot(mx, my);
    if (len > 0) {
      mx /= len;
      my /= len;
    }
    return { x: mx, y: my };
  }

  /**
   * 玩家槍械射擊：極速直線彈道，碰到第一個角色或地形即停止（不穿透多人）
   */
  private tryAttack() {
    const p = this.player;
    if (p.attackCooldown > 0 || p.swapTimer > 0) return;

    const weapon = p.weapons[p.activeHand];
    if (weapon.type === 'gun') {
      if (weapon.reloadTimer > 0 || weapon.ammoInMag <= 0) return;

      if (this.siege) {
        this.siege.playerState.recallTimer = 0;
        this.siege.playerState.outOfCombatTimer = 0;
      }
      if (p.royalShieldTimer > 0) {
        p.royalShieldTimer = 0;
        this.spawnText(p.x, p.y - 40, '遠程開火 · 聖光護盾破裂!', '#38BDF8', 1.1);
      }

      const gun = weapon.def;
      const gunProfile = this.siege ? getSiegeGunProfile(gun.kind) : null;
      const pelletsToFire = gun.kind === 'shotgun' ? Math.max(1, Math.min(gun.pellets, weapon.ammoInMag)) : gun.pellets;
      const ammoCost = gun.kind === 'shotgun' ? pelletsToFire : 1;
      p.attackCooldown = 1 / (gun.fireRate * (gunProfile?.fireRateMult ?? 1));
      p.gunfireTimer = GUNFIRE_ANIMATION_SECONDS;
      p.lastAttackAt = this.time;
      p.delayCancelReady = true;
      weapon.ammoInMag = Math.max(0, weapon.ammoInMag - ammoCost);

      const comboMult = p.comboEmpowerTimer > 0 ? 1 + p.delayCancelBonus : 1.0;
      if (p.comboEmpowerTimer > 0) p.comboEmpowerTimer = 0;

      const aimAngle = p.angle + (gun.kind === 'rifle' ? this.getPlayerRifleDrift() : 0);
      const muzzleDist = p.radius + 4;
      const spreadRad = this.getPlayerGunSpread(gun);
      const infiniteRange = Math.hypot(this.map.width, this.map.height) + TILE * 2;

      for (let i = 0; i < pelletsToFire; i++) {
        const spreadOffset = (Math.random() - 0.5) * spreadRad;
        const a = aimAngle + spreadOffset;
        const muzzleX = p.x + Math.cos(a) * muzzleDist;
        const muzzleY = p.y + Math.sin(a) * muzzleDist;
        const fullSeg = this.traceBulletSegment(p.x, p.y, a, infiniteRange, p.elevation, false);
        const fullSegDist = dist(p.x, p.y, fullSeg.x2, fullSeg.y2);
        const reachedMuzzle = fullSegDist >= muzzleDist - 0.5;

        let segEndX = fullSeg.x2;
        let segEndY = fullSeg.y2;

        // 槍械子彈碰人即止，不可一子彈攻擊兩人，且不得隔實牆、對角牆縫或地形高箱遮擋擦邊命中！
        type PlayerHitCandidate =
          | { kind: 'enemy'; enemy: EnemyEntity; t: number; perpDist: number; hitX: number; hitY: number }
          | { kind: 'structure'; structure: SiegeStructure; t: number; perpDist: number; hitX: number; hitY: number };
        const candidates: PlayerHitCandidate[] = [];
        for (const e of this.enemies) {
          if (this.mode === 'siege' && !areHostile(p.faction, 'player', e.faction, e.id)) continue;
          if (e.elevation - p.elevation >= 2.0) continue;
          const res = this.getHitscanContact(fullSeg, e);
          if (!res.hit) continue;
          if (this.findEarliestWallHit(res.hitX, res.hitY, e.x, e.y)) continue;
          const hitDist = dist(fullSeg.x1, fullSeg.y1, res.hitX, res.hitY);
          if (e.elevation - fullSeg.elevAt(hitDist) >= 2.0) continue;
          candidates.push({ kind: 'enemy', enemy: e, ...res });
        }
        if (this.siege) {
          for (const st of this.siege.structures) {
            if (!st.alive || st.faction === p.faction) continue;
            const res = segmentCircleHit(fullSeg.x1, fullSeg.y1, fullSeg.x2, fullSeg.y2, st.x, st.y, st.radius);
            if (!res.hit) continue;
            if (this.findEarliestWallHit(fullSeg.x1, fullSeg.y1, res.hitX, res.hitY)) continue;
            candidates.push({ kind: 'structure', structure: st, ...res });
          }
        }
        candidates.sort((c1, c2) => c1.t - c2.t);

        if (candidates.length > 0) {
          const hitInfo = candidates[0];
          const hitDist = dist(fullSeg.x1, fullSeg.y1, hitInfo.hitX, hitInfo.hitY);
          const firepowerMult = this.siege ? 1 + (this.siege.playerState.upgrades.firepower ?? 0) * 0.12 : 1;
          const rangeMult = this.siege ? 1 + (this.siege.playerState.upgrades.firepower ?? 0) * 0.08 : 1;
          const levelMult = this.siege ? computeSiegeLevelAttackMult(this.siege.playerState.level) : 1;
          const falloffMult = this.siege ? computeSiegeGunFalloffMult(gun.kind, hitDist, rangeMult) : 1;
          const profileDmgMult = gunProfile?.damageMult ?? 1;
          if (hitInfo.kind === 'structure') {
            const maxShotDmg =
              gun.damage *
              comboMult *
              firepowerMult *
              levelMult *
              falloffMult *
              profileDmgMult *
              (gunProfile?.structureBonusMult ?? 1);
            this.damageSiegeStructure(hitInfo.structure, Math.max(1, Math.round(maxShotDmg)), 'player', p.faction);
            segEndX = hitInfo.hitX;
            segEndY = hitInfo.hitY;
          } else {
            const centerAccuracy = clamp(1 - hitInfo.perpDist / hitInfo.enemy.radius, 0, 1);
            const accuracyFactor = 0.28 + 0.72 * centerAccuracy;
            const maxShotDmg = gun.damage * comboMult * firepowerMult * levelMult * falloffMult * profileDmgMult;
            const actualDmg = Math.max(1, Math.round(maxShotDmg * accuracyFactor));

            if (hitInfo.enemy.royalShieldTimer > 0) {
              this.deflectShieldShot(hitInfo.enemy, hitInfo.hitX, hitInfo.hitY, a);
            } else {
              this.damageEnemy(
                hitInfo.enemy,
                actualDmg,
                false,
                Math.cos(a) * 100,
                Math.sin(a) * 100,
                centerAccuracy >= 0.8,
                false,
                'player',
                p.faction,
                p.x,
                p.y,
                gunProfile?.defensePenetration ?? 0
              );
            }

            segEndX = hitInfo.hitX;
            segEndY = hitInfo.hitY;
          }
        } else if (reachedMuzzle && fullSegDist < infiniteRange - 1) {
          this.spawnBurst(fullSeg.x2, fullSeg.y2, '#E2E8F0', 4);
        }

        const endDist = dist(p.x, p.y, segEndX, segEndY);
        const beamStartX = reachedMuzzle && endDist > muzzleDist ? muzzleX : p.x;
        const beamStartY = reachedMuzzle && endDist > muzzleDist ? muzzleY : p.y;

        this.pushBeam({
          x1: beamStartX,
          y1: beamStartY,
          x2: segEndX,
          y2: segEndY,
          color: gun.color,
          life: gun.kind === 'sniper' ? 0.15 : 0.09,
          maxLife: gun.kind === 'sniper' ? 0.15 : 0.09,
          width: gun.kind === 'sniper' ? 3.0 : gun.kind === 'shotgun' ? 1.8 : 2.1,
        });
      }

      this.crosshairBloom = Math.min(gun.maxCrosshair - gun.baseCrosshair, this.crosshairBloom + gun.bloomPerShot);
      if (gun.kind === 'sniper') {
        this.crosshairBloomDelay = Math.max(this.crosshairBloomDelay, SNIPER_AIM.settleDelaySeconds);
      } else if (gun.kind === 'rifle') {
        this.rifleRecoilAngle = Math.min(RIFLE_RECOIL.maxAngle, this.rifleRecoilAngle + RIFLE_RECOIL.kick);
      }

      this.camera.shake = Math.min(8, this.camera.shake + (gun.kind === 'shotgun' || gun.kind === 'sniper' ? 4.5 : 1.4));
      sfx.gunshot(gun.kind);
      this.emitNetSfx('gun', p.x, p.y, gun.kind);
      const fxMuzzleX = p.x + Math.cos(p.angle) * muzzleDist;
      const fxMuzzleY = p.y + Math.sin(p.angle) * muzzleDist;
      if (!this.findEarliestWallHit(p.x, p.y, fxMuzzleX, fxMuzzleY)) {
        this.spawnBurst(fxMuzzleX, fxMuzzleY, gun.color, gun.kind === 'shotgun' ? 7 : 3);
      }
    }
  }

  private performMeleeAttack() {
    const p = this.player;
    if (p.swapTimer > 0 || (!p.chargeReady && p.attackCooldown > 0)) return;

    const weapon = p.weapons[p.activeHand];
    if (weapon.type !== 'melee') return;
    const melee = weapon.def;
    const comboMult = p.comboEmpowerTimer > 0 ? 1 + p.delayCancelBonus : 1.0;

    if (p.chargeReady && p.freezeTimer <= 0) {
      p.chargeReady = false;
      p.attackCooldown = 0.25;
      p.lastAttackAt = this.time;
      p.delayCancelReady = true;
      p.attackAnimDuration = melee.kind === 'greatsword' ? 0.26 : 0.16;
      p.attackAnimTimer = p.attackAnimDuration;
      p.attackAnimKind = melee.kind;
      if (p.comboEmpowerTimer > 0) p.comboEmpowerTimer = 0;
      sfx.ultimate();
      this.emitNetSfx('skill', p.x, p.y);
      this.camera.shake = 8;
      this.executePlayerFactionMeleeSkill(weapon, comboMult);
      return;
    }

    p.attackCooldown = 1 / (melee.swingRate * (p.freezeTimer > 0 ? 0.9 : 1));
    p.lastAttackAt = this.time;
    p.delayCancelReady = true;
    p.attackAnimDuration = melee.kind === 'greatsword' ? 0.24 : 0.16;
    p.attackAnimTimer = p.attackAnimDuration;
    p.attackAnimKind = melee.kind;
    if (p.comboEmpowerTimer > 0) p.comboEmpowerTimer = 0;

    if (melee.kind === 'shield') {
      sfx.shieldBash();
    } else {
      sfx.slash(melee.kind);
    }
    this.emitNetSfx('melee', p.x, p.y, melee.kind);
    const giantMult = p.giantTimer > 0 ? 1.3 : 1.0;
    const bladeMult = this.siege ? 1 + (this.siege.playerState.upgrades.blade ?? 0) * 0.14 : 1.0;
    const levelMult = this.siege ? computeSiegeLevelAttackMult(this.siege.playerState.level) : 1.0;
    const dmg = Math.round(melee.damage * comboMult * giantMult * bladeMult * levelMult);
    if (this.siege) {
      this.siege.playerState.recallTimer = 0;
      this.siege.playerState.outOfCombatTimer = 0;
    }
    if (melee.kind !== 'shield') {
      const style = melee.kind === 'knife' ? 'thrust' : melee.kind === 'claw' ? 'claw' : 'sweep';
      this.pushSlash({
        x: p.x,
        y: p.y,
        angle: p.angle,
        arc: melee.arc,
        reach: melee.reach * p.sizeScale,
        color: melee.color,
        life: melee.kind === 'greatsword' ? 0.24 : 0.16,
        maxLife: melee.kind === 'greatsword' ? 0.24 : 0.16,
        isUltimate: false,
        style,
      });
    }

    this.applyPlayerMeleeHitbox(
      p.x,
      p.y,
      p.elevation,
      p.angle,
      melee.arc,
      melee.reach * p.sizeScale,
      dmg,
      melee.kind === 'shield'
    );
  }

  private executePlayerFactionMeleeSkill(weapon: Extract<EquippedWeapon, { type: 'melee' }>, comboMult: number) {
    const p = this.player;
    const fac = p.faction;
    const mk = weapon.def.kind;
    if (this.mode === 'siege' && this.siege && mk !== 'shield') {
      const ultId = this.siege.playerState.loadout.ultimateId;
      const ultMeta = getUltimateMeta(ultId);
      this.activeSkillBanner = `${FACTIONS[fac].name} · ${ultMeta.name}`;
      this.activeSkillBannerTimer = 2.5;
      this.castSiegeUltimateSkill('player', p, ultId, p.angle, comboMult);
      this.emitHud();
      return;
    }
    const facColor = FACTIONS[fac].accentHex;
    const skillName = FACTIONS[fac].meleeSkills[mk].name;

    this.activeSkillBanner = `${FACTIONS[fac].name} · ${skillName}`;
    this.activeSkillBannerTimer = 2.5;

    if (mk === 'shield') {
      weapon.durability = p.maxShield;
      this.spawnText(p.x, p.y - 44, `${skillName}! (盾牌滿 100)`, '#38BDF8', 1.3);
      this.pushSlash({
        x: p.x,
        y: p.y,
        angle: p.angle,
        arc: Math.PI * 1.4,
        reach: 120,
        color: '#38BDF8',
        life: 0.26,
        maxLife: 0.26,
        isUltimate: true,
        style: 'sweep',
      });
      for (const e of [...this.enemies]) {
        if (!areHostile(p.faction, 'player', e.faction, e.id)) continue;
        if (Math.abs(p.elevation - e.elevation) > 1.0) continue;
        const d = dist(p.x, p.y, e.x, e.y);
        if (d <= 125 + e.radius) {
          const pushAng = Math.atan2(e.y - p.y, e.x - p.x);
          this.damageEnemy(
            e,
            0,
            true,
            Math.cos(pushAng) * 1050,
            Math.sin(pushAng) * 1050,
            false,
            true,
            'player',
            p.faction,
            p.x,
            p.y
          );
          e.stunTimer = Math.max(e.stunTimer, 0.45);
        }
      }
      this.emitHud();
      return;
    }

    this.spawnText(p.x, p.y - 44, `${skillName}!`, facColor, 1.3);

    if (fac === 'royal') {
      if (mk === 'knife') {
        p.royalShieldTimer = 6.5;
        p.royalShieldImpact = undefined;
      } else if (mk === 'claw') {
        const hostiles = this.enemies.filter((e) => areHostile(p.faction, 'player', e.faction, e.id));
        if (hostiles.length > 0) {
          hostiles.sort((a, b) => dist(p.x, p.y, a.x, a.y) - dist(p.x, p.y, b.x, b.y));
          const target = hostiles[0];
          const approachAng = Math.atan2(target.y - p.y, target.x - p.x);
          const safeSpot = this.findSafeTeleportSpot(
            target.x,
            target.y,
            approachAng,
            p.radius + target.radius + 6,
            p.radius,
            p.x,
            p.y
          );
          this.addSkillTrace('blink', p, safeSpot, 0.58);
          p.x = safeSpot.x;
          p.y = safeSpot.y;
          p.elevation = this.getWalkableElevation(p.x, p.y);
          p.invulnTimer = Math.max(p.invulnTimer, 0.35);
        }
        this.pushSlash({
          x: p.x,
          y: p.y,
          angle: 0,
          arc: Math.PI * 2,
          reach: 220,
          color: '#FFFFFF',
          life: 0.25,
          maxLife: 0.25,
          isUltimate: true,
          style: 'sweep',
        });
        for (const e of this.enemies) {
          if (!areHostile(p.faction, 'player', e.faction, e.id)) continue;
          const d = dist(p.x, p.y, e.x, e.y);
          if (d <= 260) {
            const blindSec = clamp(1.0 - (d / 260) * 0.5, 0.5, 1.0);
            e.blindTimer = Math.max(e.blindTimer, blindSec);
            this.spawnText(e.x, e.y - 34, `致盲 ${blindSec.toFixed(1)}s`, '#FEF08A', 1.05);
          }
        }
      } else {
        const spreadAngles = [-0.34, -0.17, 0, 0.17, 0.34];
        for (const off of spreadAngles) {
          const a = p.angle + off;
          this.projectiles.push({
            id: uid('lightorb'),
            x: p.x + Math.cos(a) * 26,
            y: p.y + Math.sin(a) * 26,
            prevX: p.x,
            prevY: p.y,
            vx: Math.cos(a) * 560,
            vy: Math.sin(a) * 560,
            radius: 13,
            damage: Math.round(30 * comboMult),
            startElevation: p.elevation,
            minTraversedElevation: p.elevation,
            ownerId: 'player',
            ownerFaction: p.faction,
            fromPlayer: true,
            isAlly: true,
            noFriendlyFire: false,
            color: '#FACC15',
            life: 1.25,
            maxLife: 1.25,
            pierce: 99,
            isLightOrb: true,
            hitIds: new Set(),
          });
        }
      }
      this.emitHud();
      return;
    }

    if (fac === 'shadow') {
      if (mk === 'knife') {
        p.eagleEyeTimer = EAGLE_EYE_DURATION;
      } else if (mk === 'claw') {
        p.shadowCloneTimer = 6.5;
      } else {
        const dir = snapToEightDirections(p.angle);
        this.pushSlash({
          x: p.x,
          y: p.y,
          angle: dir.angle,
          arc: Math.PI * 0.9,
          reach: weapon.def.reach + 20,
          color: '#4338CA',
          life: 0.25,
          maxLife: 0.25,
          isUltimate: true,
          style: 'sweep',
        });
        const startX = p.x + dir.dx * 28;
        const startY = p.y + dir.dy * 28;
        const headDmg = Math.round(20 * comboMult);
        const bodyDmg = Math.round(15 * comboMult);
        this.projectiles.push({
          id: uid('blackdragon'),
          x: startX,
          y: startY,
          prevX: p.x,
          prevY: p.y,
          vx: dir.dx * 340,
          vy: dir.dy * 340,
          radius: 22,
          damage: headDmg,
          headDamage: headDmg,
          bodyDamage: bodyDmg,
          startElevation: p.elevation,
          minTraversedElevation: p.elevation,
          ownerId: 'player',
          ownerFaction: p.faction,
          fromPlayer: true,
          isAlly: true,
          noFriendlyFire: true,
          color: '#312E81',
          life: 3.5,
          maxLife: 3.5,
          pierce: 99,
          isWave: true,
          isBlackDragon: true,
          segments: [{ x: startX, y: startY }],
          bouncesLeft: 5,
          distanceTraveled: 0,
          maxDistance: 1050,
          targetHitCooldowns: {},
          hitIds: new Set(),
        });
      }
      this.emitHud();
      return;
    }

    if (mk === 'knife') {
      p.vampireTimer = 7.5;
    } else if (mk === 'claw') {
      p.giantTimer = 0;
      p.shrinkTimer = 7.5;
    } else {
      p.shrinkTimer = 0;
      p.giantTimer = 7.5;
    }
    this.emitHud();
  }

  private applyPlayerMeleeHitbox(
    ox: number,
    oy: number,
    attackerElev: number,
    aimAngle: number,
    arc: number,
    reach: number,
    damage: number,
    isShieldPush = false
  ) {
    const knockPower = isShieldPush ? SHIELD_BASH_DISTANCE / 0.05 : 200;
    for (const enemy of [...this.enemies]) {
      if (Math.abs(attackerElev - enemy.elevation) > 1.0) continue;
      const d = dist(ox, oy, enemy.x, enemy.y);
      if (d <= reach + enemy.radius) {
        const ang = Math.atan2(enemy.y - oy, enemy.x - ox);
        if (Math.abs(angleDiff(aimAngle, ang)) <= arc * 0.62) {
          this.damageEnemy(
            enemy,
            damage,
            true,
            Math.cos(ang) * knockPower,
            Math.sin(ang) * knockPower,
            false,
            false,
            'player',
            this.player.faction,
            ox,
            oy
          );
          if (isShieldPush && this.enemies.includes(enemy)) {
            enemy.stunTimer = Math.max(enemy.stunTimer, 0.18);
          }
        }
      }
    }
    if (this.siege && damage > 0) {
      for (const st of this.siege.structures) {
        if (!st.alive || st.faction === this.player.faction) continue;
        if (dist(ox, oy, st.x, st.y) <= reach + st.radius) {
          const ang = Math.atan2(st.y - oy, st.x - ox);
          if (Math.abs(angleDiff(aimAngle, ang)) <= arc * 0.62) {
            this.damageSiegeStructure(st, damage, 'player', this.player.faction);
          }
        }
      }
    }
  }

  private isFrontalShieldBlock(defX: number, defY: number, defAngle: number, origX: number, origY: number): boolean {
    const incomingAngle = Math.atan2(origY - defY, origX - defX);
    return Math.abs(angleDiff(defAngle, incomingAngle)) <= Math.PI * 0.38;
  }

  private getActorSkillVisuals(actor: PlayerState | EnemyEntity): ActorSkillVisuals {
    const existing = this.actorSkillVisuals.get(actor);
    if (existing) return existing;
    const visuals = { mistX: actor.x, mistY: actor.y, mistOpacity: 0, sizeScale: 1 };
    this.actorSkillVisuals.set(actor, visuals);
    return visuals;
  }

  private updateActorSkillVisuals(actor: PlayerState | EnemyEntity, dt: number) {
    const visuals = this.getActorSkillVisuals(actor);
    const mistTarget = actor.vampireTimer > 0 ? 1 : 0;
    if (visuals.mistOpacity < 0.015) {
      visuals.mistX = actor.x;
      visuals.mistY = actor.y;
    } else {
      const follow = 1 - Math.exp(-dt * 8);
      visuals.mistX += (actor.x - visuals.mistX) * follow;
      visuals.mistY += (actor.y - visuals.mistY) * follow;
      const trail = dist(actor.x, actor.y, visuals.mistX, visuals.mistY);
      const maxTrail = actor.radius * 1.6;
      if (trail > maxTrail) {
        visuals.mistX = actor.x + (visuals.mistX - actor.x) * maxTrail / trail;
        visuals.mistY = actor.y + (visuals.mistY - actor.y) * maxTrail / trail;
      }
    }
    visuals.mistOpacity += (mistTarget - visuals.mistOpacity) * (1 - Math.exp(-dt * 7));
    const morph = 1 - Math.exp(-dt * (actor.sizeScale > visuals.sizeScale ? 15 : 20));
    visuals.sizeScale += (actor.sizeScale - visuals.sizeScale) * morph;
    if (Math.abs(actor.sizeScale - visuals.sizeScale) < 0.002) visuals.sizeScale = actor.sizeScale;
  }

  private markShadowDodge(actor: PlayerState | EnemyEntity, originX?: number, originY?: number) {
    const shotAngle = originX !== undefined && originY !== undefined
      ? Math.atan2(actor.y - originY, actor.x - originX)
      : actor.angle;
    const side = Math.sin(actor.angle - shotAngle) < 0 ? -1 : 1;
    this.getActorSkillVisuals(actor).shadowDodge = { startedAt: this.time, angle: shotAngle + side * Math.PI / 2 };
  }

  private drawActorSkillEffects(ctx: CanvasRenderingContext2D, actor: PlayerState | EnemyEntity, visuals: ActorSkillVisuals) {
    if (visuals.mistOpacity > 0.015) {
      drawVampireMist(ctx, actor, visuals, this.time);
    }
    if (visuals.sizeScale !== 1 || actor.sizeScale !== 1) {
      drawMorphGround(ctx, actor, visuals.sizeScale, this.time);
    }
  }

  private addSkillTrace(
    kind: SkillTrace['kind'],
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration: number
  ) {
    this.skillTraces.push({
      kind, fromX: from.x, fromY: from.y, destination: to, startedAt: this.time, duration,
    });
    if (this.multiplayer?.role === 'host') {
      this.netEvents.push({
        k: 'trace',
        kind,
        fx: round1(from.x),
        fy: round1(from.y),
        tx: round1(to.x),
        ty: round1(to.y),
        dur: duration,
      });
    }
  }

  private getRemoteHumanByEntityId(entityId?: string): RemoteHumanRuntime | undefined {
    if (!entityId || !entityId.startsWith('human_')) return undefined;
    return this.remoteHumans.get(entityId.slice(6));
  }

  private applyLocalReputationChange(change: Record<FactionId, number>) {
    if (change.royal === 0 && change.shadow === 0 && change.mercenary === 0) return;
    const p = this.player;
    p.reputations.royal += change.royal;
    p.reputations.shadow += change.shadow;
    p.reputations.mercenary += change.mercenary;
    p.reputation = p.reputations[p.faction];
    this.onReputationChange?.({ ...p.reputations }, change);
  }

  private recordKillReputation(
    attackerId: string | undefined,
    victim: { faction: FactionId; x: number; y: number },
    friendlyFire: boolean
  ) {
    if (this.mode === 'siege') return;
    const local = attackerId === 'player';
    const remote = this.getRemoteHumanByEntityId(attackerId);
    if (!local && !remote) return;
    const faction = remote?.faction ?? this.player.faction;
    const change = { royal: 0, shadow: 0, mercenary: 0 };
    change[faction] = friendlyFire ? -1 : 1;
    if (!friendlyFire && victim.faction !== 'mercenary') change[victim.faction] -= 1;

    if (remote) {
      remote.reputationChanges.royal += change.royal;
      remote.reputationChanges.shadow += change.shadow;
      remote.reputationChanges.mercenary += change.mercenary;
      return;
    }

    this.applyLocalReputationChange(change);
    if (friendlyFire) {
      this.spawnText(victim.x, victim.y - 32, '誤傷擊殺友軍! -1 聲望', '#F87171', 1.15);
    } else {
      const facShort: Record<FactionId, string> = { royal: '皇家', shadow: '天影', mercenary: '第三' };
      const toast = victim.faction === 'mercenary'
        ? `+1 ${facShort[faction]}聲望`
        : `+1 ${facShort[faction]} · -1 ${facShort[victim.faction]}`;
      this.spawnText(victim.x, victim.y - 42, toast, '#7DD3FC', 0.85, true);
    }
  }

  private applyVampireHealing(attacker: PlayerState | EnemyEntity, victim: { x: number; y: number }, damage: number, melee: boolean) {
    const heal = Math.max(1, Math.round(damage * (melee ? 0.5 : 1 / 3)));
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
    this.addSkillTrace('siphon', victim, attacker, 0.64);
  }

  private damageEnemy(
    enemy: EnemyEntity,
    baseDmg: number,
    isMelee: boolean,
    knockX: number,
    knockY: number,
    bullseye: boolean,
    noFriendlyFire: boolean,
    attackerId: string,
    attackerFaction: FactionId,
    hitOriginX?: number,
    hitOriginY?: number,
    defensePenetration = 0
  ) {
    if ((enemy.invulnTimer ?? 0) > 0) return;
    const p = this.player;
    const isPlayerAttacker = attackerId === 'player';
    const isHostile = areHostile(attackerFaction, attackerId, enemy.faction, enemy.id);

    if (!isHostile) {
      if (noFriendlyFire || baseDmg <= 0 || this.mode === 'siege') return;
      const ffDmg = Math.max(1, Math.round(baseDmg * 0.5));
      enemy.hp -= ffDmg;
      enemy.hitFlash = 0.12;
      if (enemy.hp <= 0) {
        this.removeEnemy(enemy, attackerId, true);
      } else {
        this.spawnText(enemy.x, enemy.y - 24, `誤傷友軍 -${ffDmg}`, '#FCA5A5', 0.86, true);
      }
      return;
    }

    // 敵人技能防禦判定：皇家護盾、天影影分身閃避（近戰命中立即破除影分身）、第三變大減傷 / 變細近傷增加
    if (enemy.royalShieldTimer > 0 && !isMelee) {
      this.markShieldImpact(enemy, hitOriginX, hitOriginY);
      return;
    }
    if (enemy.shadowCloneTimer > 0) {
      if (isMelee) {
        enemy.shadowCloneTimer = 0;
        this.getActorSkillVisuals(enemy).shadowDodge = undefined;
        this.spawnText(enemy.x, enemy.y - 38, '近戰破除影分身!', '#FB7185', 1.05);
      } else if (Math.random() < 2 / 3) {
        this.markShadowDodge(enemy, hitOriginX, hitOriginY);
        return;
      }
    }

    let dmg = baseDmg;
    if (enemy.royalShieldTimer > 0 && isMelee) dmg *= 0.8;
    if (enemy.shrinkTimer > 0 && isMelee) dmg *= 1.35;
    if (enemy.giantTimer > 0) dmg *= 0.9;

    if (this.siege && dmg > 0) {
      if (enemy.siegeAegisReflectTimer && enemy.siegeAegisReflectTimer > 0) {
        dmg *= 0.4;
        if (!isMelee && hitOriginX !== undefined && hitOriginY !== undefined) {
          const reflectDmg = Math.max(2, Math.round(baseDmg * 0.35));
          if (isPlayerAttacker && p.hp > 0) {
            this.damagePlayer(reflectDmg, false, enemy.id, enemy.x, enemy.y);
          } else {
            const ae = this.enemies.find((x) => x.id === attackerId);
            if (ae && ae.hp > 0) {
              ae.hp = Math.max(1, ae.hp - reflectDmg);
              this.spawnText(ae.x, ae.y - 26, `反震 -${reflectDmg}`, '#38BDF8', 0.85, true);
            }
          }
        }
      }
      if ((enemy.siegeMarkedTimer ?? 0) > 0) {
        dmg *= 1.22;
      }
      if (this.isInSanctuaryZone(enemy.x, enemy.y, enemy.faction)) {
        dmg *= 0.75;
      }
      const attackerHero = this.getSiegeHeroState(attackerId);
      if (attackerHero) {
        if (attackerHero.loadout.passiveId === 'shadow_assassin' && enemy.hp / enemy.maxHp < 0.45) {
          dmg *= 1.2;
        }
        if (
          attackerHero.loadout.passiveId === 'shadow_executioner' &&
          (enemy.siegeUnitKind === 'hero' || enemy.siegeUnitKind === 'boss')
        ) {
          dmg *= 1.15;
        }
      }
      const victimHeroState = this.getSiegeHeroState(enemy.id);
      const victimDef = victimHeroState
        ? computeSiegeDefense(victimHeroState)
        : enemy.siegeUnitKind === 'hero'
          ? computeSiegeDefense({
              level: enemy.siegeLevel ?? 1,
              upgrades: enemy.siegeUpgrades ?? { firepower: 0, blade: 0, armor: 0, core: 0 },
            })
          : 0;
      if (victimDef > 0) {
        dmg = applySiegeDefenseReduction(dmg, victimDef, defensePenetration);
      }
    }

    let finalDmg = baseDmg <= 0 ? 0 : Math.max(1, Math.round(dmg));

    // 手持盾牌：只擋來自正面的攻擊（側面／背面無法格擋；純推擊 0 傷不消耗盾牌耐久）
    const enemyActiveWeapon = enemy.weapons[enemy.activeHand];
    const enemyHoldingShield =
      enemyActiveWeapon.type === 'melee' &&
      enemyActiveWeapon.def.kind === 'shield' &&
      enemyActiveWeapon.durability > 0;
    if (enemyHoldingShield && finalDmg > 0) {
      const originPos =
        hitOriginX !== undefined && hitOriginY !== undefined
          ? { x: hitOriginX, y: hitOriginY }
          : isPlayerAttacker
            ? { x: p.x, y: p.y }
            : (() => {
                const ae = this.enemies.find((x) => x.id === attackerId);
                return ae ? { x: ae.x, y: ae.y } : null;
              })();
      const frontalBlocked = originPos
        ? this.isFrontalShieldBlock(enemy.x, enemy.y, enemy.angle, originPos.x, originPos.y)
        : true;
      if (frontalBlocked) {
        const shieldRes = applyFrontalShieldMitigation(finalDmg, enemyActiveWeapon.durability, isMelee);
        enemyActiveWeapon.durability = shieldRes.nextDurability;
        finalDmg = shieldRes.finalDmg;
        if (shieldRes.banner) {
          this.spawnText(enemy.x, enemy.y - 30, shieldRes.banner.text, shieldRes.banner.color, 0.95);
        }
        if (enemyActiveWeapon.durability <= 0) {
          enemy.weapons[enemy.activeHand] = { type: 'melee', def: DEFAULT_KNIFE, durability: 0 };
          enemy.chargingMelee = false;
          enemy.chargeReady = false;
        }
      }
    }

    if (finalDmg > 0) {
      enemy.hp -= finalDmg;
      enemy.hitFlash = 0.12;
    }

    const pushed = this.moveCharacterWithElevation(
      enemy.x,
      enemy.y,
      enemy.elevation,
      knockX * 0.05,
      knockY * 0.05,
      enemy.radius
    );
    enemy.x = pushed.x;
    enemy.y = pushed.y;
    enemy.elevation = pushed.elevation;

    const attackerEntity = isPlayerAttacker ? null : this.enemies.find((ae) => ae.id === attackerId);
    const attackerPos = isPlayerAttacker && p.hp > 0
      ? { x: p.x, y: p.y }
      : attackerEntity
        ? { x: attackerEntity.x, y: attackerEntity.y }
        : null;

    if (attackerPos) {
      const shouldSwitchAggro =
        !enemy.focusedTargetId ||
        (enemy.focusedTargetId !== attackerId && (!enemy.hasLosToTarget || Math.random() < 0.6));
      if (shouldSwitchAggro) {
        if (finalDmg > 0 && enemy.visibleTargetId !== attackerId) {
          const surpriseDelay = (AI_COMBAT[enemy.archetype].reactionSeconds + AI_SURPRISE_SECONDS)
            * AI_DIFFICULTY[this.difficulty].reactionMultiplier;
          enemy.reactionTimer = Math.max(enemy.reactionTimer, surpriseDelay);
          enemy.chargingMelee = false;
          enemy.chargeReady = false;
        }
        enemy.focusedTargetId = attackerId;
        enemy.aggroLockTimer = 5.0;
        enemy.lastSeenTargetPos = { x: attackerPos.x, y: attackerPos.y };
        enemy.alertTimer = 7.0;
        enemy.pathTimer = 0;
      } else if (enemy.focusedTargetId === attackerId) {
        enemy.lastSeenTargetPos = { x: attackerPos.x, y: attackerPos.y };
        enemy.alertTimer = Math.max(enemy.alertTimer, 6.5);
      }
    }

    if (isPlayerAttacker) {
      p.totalDamage += finalDmg;
      p.score += finalDmg;

      if (p.hp > 0 && finalDmg > 0) {
        if (p.vampireTimer > 0) {
          this.applyVampireHealing(p, enemy, finalDmg, isMelee);
        } else if (
          this.siege &&
          (p.faction === 'royal' || p.faction === 'shadow') &&
          this.siege.teamBuffs[p.faction].baronTimer > 0
        ) {
          const heal = Math.max(1, Math.round(finalDmg * 0.15));
          p.hp = Math.min(p.maxHp, p.hp + heal);
        }
      }

      if (finalDmg > 0) {
        sfx.hit(bullseye);
        this.emitNetSfx('hit', enemy.x, enemy.y, undefined, bullseye);
      }
    } else {
      const attackingHumanRuntime = this.getRemoteHumanByEntityId(attackerId);
      if (attackingHumanRuntime && finalDmg > 0) {
        attackingHumanRuntime.totalDamage += finalDmg;
        attackingHumanRuntime.score += finalDmg;
        this.emitNetSfx('hit', enemy.x, enemy.y, undefined, bullseye);
      }
      if (attackerEntity && finalDmg > 0) {
        if (attackerEntity.vampireTimer > 0) {
          this.applyVampireHealing(attackerEntity, enemy, finalDmg, isMelee);
        } else if (
          this.siege &&
          (attackerEntity.faction === 'royal' || attackerEntity.faction === 'shadow') &&
          this.siege.teamBuffs[attackerEntity.faction].baronTimer > 0
        ) {
          const heal = Math.max(1, Math.round(finalDmg * 0.15));
          attackerEntity.hp = Math.min(attackerEntity.maxHp, attackerEntity.hp + heal);
        }
      }
    }

    if (this.siege && finalDmg > 0 && enemy.siegeUnitKind === 'hero' && (attackerId === 'player' || this.enemies.some((a) => a.id === attackerId && a.siegeUnitKind === 'hero'))) {
      this.notifySiegeTurretHeroAggro(attackerId, enemy);
    }

    this.spawnBurst(enemy.x, enemy.y, finalDmg === 0 ? '#FFFFFF' : bullseye ? '#FBBF24' : '#F87171', bullseye ? 7 : 5);
    if (finalDmg > 0) {
      this.spawnText(
        enemy.x + (Math.random() - 0.5) * 16,
        enemy.y - 24,
        `-${finalDmg}`,
        '#EF4444',
        0.86,
        true
      );
    }

    if (enemy.hp <= 0) {
      this.removeEnemy(enemy, attackerId);
    }
  }

  private removeEnemy(enemy: EnemyEntity, attackerId?: string, friendlyFire = false, cause: 'attack' | 'ice' = 'attack') {
    const idx = this.enemies.indexOf(enemy);
    if (idx === -1) return;
    this.enemies.splice(idx, 1);
    this.spawnBurst(enemy.x, enemy.y, enemy.color, 14);
    sfx.soldierDown(this.nearbySoundVolume(enemy.x, enemy.y) * 0.75);
    this.emitNetSfx('down', enemy.x, enemy.y);

    this.recordKillReputation(attackerId, enemy, friendlyFire);

    if (this.siege) {
      this.handleSiegeEnemyRemoved(enemy, attackerId);
    }

    if (attackerId === 'player' && !friendlyFire) {
      const p = this.player;
      p.kills += 1;
      p.comboCount += 1;
      p.comboTimer = 4.0;
      p.maxCombo = Math.max(p.maxCombo, p.comboCount);

      p.score += 120 + p.comboCount * 15;
      this.factionScores[p.faction] += 25;
    } else if (cause === 'attack') {
      const killerRt = this.getRemoteHumanByEntityId(attackerId);
      if (killerRt) {
        killerRt.kills += 1;
        killerRt.comboCount += 1;
        killerRt.comboTimer = 4.0;
        killerRt.maxCombo = Math.max(killerRt.maxCombo, killerRt.comboCount);
        killerRt.score += 120 + killerRt.comboCount * 15;
        this.factionScores[killerRt.faction] += 25;
      }
    }

    if (enemy.isHumanPlayer && enemy.peerId) {
      const victimRt = this.remoteHumans.get(enemy.peerId);
      if (victimRt) {
        if (this.siege) {
          const rState = this.siege.remoteStates.get(enemy.peerId);
          if (rState) rState.deaths += 1;
          const respSec = computeSiegeRespawnSeconds(this.siege.matchTime, this.siege.suddenDeath);
          victimRt.respawnTimer = respSec;
          this.spawnText(enemy.x, enemy.y - 36, `${victimRt.name} 陣亡 (${respSec}s 後復活)`, '#FBBF24', 1.0);
        } else {
          victimRt.lives = Math.max(0, victimRt.lives - 1);
          if (victimRt.lives > 0) {
            victimRt.respawnTimer = RESPAWN_DELAY_SECONDS;
            this.spawnText(enemy.x, enemy.y - 36, `${victimRt.name} 重傷撤離 (剩 ${victimRt.lives} 命)`, '#FBBF24', 1.0);
          } else {
            this.spawnText(enemy.x, enemy.y - 36, `${victimRt.name} 已陣亡淘汰`, '#F87171', 1.05);
          }
        }
      }
    }

    if (!this.siege) {
      // 場上武器數量固定：只有非預設武器（非小槍／非小刀）會在持有者陣亡時掉回地面，防彈盾保留剩餘耐久
      const droppedFirst = this.dropWeapon(enemy.weapons[0], enemy.x, enemy.y);
      const secondX = droppedFirst ? clamp(enemy.x + 18, TILE * 0.5, this.map.width - TILE * 0.5) : enemy.x;
      this.dropWeapon(enemy.weapons[1], secondX, enemy.y);
    }

    this.checkVictoryCondition();
    this.emitHud();
  }

  private damagePlayer(
    rawDmg: number,
    isMeleeAttack: boolean,
    attackerId?: string,
    hitOriginX?: number,
    hitOriginY?: number,
    isFriendlyFire = false,
    defensePenetration = 0
  ) {
    const p = this.player;
    if (p.hp <= 0 || p.invulnTimer > 0) return;

    if (isFriendlyFire) {
      if (rawDmg <= 0) return;
      const ffDmg = Math.max(1, Math.round(rawDmg));
      p.hp -= ffDmg;
      this.spawnText(p.x, p.y - 34, `誤傷友軍 -${ffDmg}`, '#FCA5A5', 0.86, true);
      p.invulnTimer = 0.2;
      if (p.hp <= 0) {
        this.handlePlayerDeath(attackerId);
      } else {
        sfx.playerHurt();
        this.emitHud();
      }
      return;
    }

    if (p.royalShieldTimer > 0 && !isMeleeAttack) {
      this.markShieldImpact(p, hitOriginX, hitOriginY);
      return;
    }

    if (p.shadowCloneTimer > 0) {
      if (isMeleeAttack) {
        p.shadowCloneTimer = 0;
        this.getActorSkillVisuals(p).shadowDodge = undefined;
        this.spawnText(p.x, p.y - 44, '近戰破除影分身!', '#FB7185', 1.15);
      } else if (Math.random() < 2 / 3) {
        this.markShadowDodge(p, hitOriginX, hitOriginY);
        return;
      }
    }

    let dmg = rawDmg;
    if (p.royalShieldTimer > 0 && isMeleeAttack) dmg *= 0.8;
    if (p.shrinkTimer > 0 && isMeleeAttack) dmg *= 1.35;
    if (p.giantTimer > 0) dmg *= 0.9;

    if (this.siege && dmg > 0) {
      const ps = this.siege.playerState;
      ps.recallTimer = 0;
      if (ps.aegisReflectTimer > 0) {
        dmg *= 0.4;
        if (!isMeleeAttack && attackerId) {
          const ae = this.enemies.find((e) => e.id === attackerId);
          if (ae && ae.hp > 0) {
            const reflectDmg = Math.max(2, Math.round(rawDmg * 0.35));
            this.damageEnemy(ae, reflectDmg, false, 0, 0, false, true, 'player', p.faction, p.x, p.y);
          }
        }
      }
      if (ps.markedTimer > 0) dmg *= 1.22;
      if (this.isInSanctuaryZone(p.x, p.y, p.faction === 'shadow' ? 'shadow' : 'royal')) {
        dmg *= 0.75;
      }
      if (attackerId?.startsWith('turret_') && ps.loadout.passiveId === 'royal_fortitude') {
        dmg *= 0.85;
      }
      if (attackerId) {
        const attackerHero = this.getSiegeHeroState(attackerId);
        if (attackerHero) {
          if (attackerHero.loadout.passiveId === 'shadow_assassin' && p.hp / p.maxHp < 0.45) {
            dmg *= 1.2;
          }
          if (attackerHero.loadout.passiveId === 'shadow_executioner') {
            dmg *= 1.15;
          }
        }
      }
      dmg = applySiegeDefenseReduction(dmg, computeSiegeDefense(ps), defensePenetration);
    }

    let finalDmg = rawDmg <= 0 ? 0 : Math.max(2, Math.round(dmg));

    // 手持盾牌且攻擊來自正面時才能格擋
    const weapon = p.weapons[p.activeHand];
    if (finalDmg > 0 && weapon.type === 'melee' && weapon.def.kind === 'shield' && weapon.durability > 0) {
      const originPos =
        hitOriginX !== undefined && hitOriginY !== undefined
          ? { x: hitOriginX, y: hitOriginY }
          : attackerId
            ? (() => {
                const ae = this.enemies.find((e) => e.id === attackerId);
                return ae ? { x: ae.x, y: ae.y } : null;
              })()
            : null;
      const frontalBlocked = originPos
        ? this.isFrontalShieldBlock(p.x, p.y, p.angle, originPos.x, originPos.y)
        : true;
      if (frontalBlocked) {
        const shieldRes = applyFrontalShieldMitigation(finalDmg, weapon.durability, isMeleeAttack);
        weapon.durability = shieldRes.nextDurability;
        finalDmg = shieldRes.finalDmg;
        if (shieldRes.banner) {
          this.spawnText(p.x, p.y - 36, shieldRes.banner.text, shieldRes.banner.color, 0.95);
        }
        if (weapon.durability <= 0) {
          p.weapons[p.activeHand] = { type: 'melee', def: DEFAULT_KNIFE, durability: 0 };
          this.cancelMeleeCharge();
        }
      }
    }

    if (finalDmg > 0) {
      p.hp -= finalDmg;
      this.spawnText(p.x, p.y - 34, `-${finalDmg}`, '#EF4444', 0.86, true);
      if (attackerId) {
        const ae = this.enemies.find((e) => e.id === attackerId);
        if (ae && ae.vampireTimer > 0) {
          this.applyVampireHealing(ae, p, finalDmg, isMeleeAttack);
        }
      }
    }

    p.invulnTimer = finalDmg > 0 ? 0.2 : rawDmg > 0 ? 0.08 : 0.04;
    if (p.hp <= 0) {
      this.handlePlayerDeath(attackerId);
    } else {
      if (rawDmg > 0) sfx.playerHurt();
      this.emitHud();
    }
  }

  private handlePlayerDeath(attackerId?: string) {
    const p = this.player;
    const attacker = this.getRemoteHumanByEntityId(attackerId);
    if (attacker) {
      this.recordKillReputation(attacker.entityId, p, !areHostile(attacker.faction, attacker.entityId, p.faction, 'player'));
    }
    p.hp = 0;
    this.clearInputs();
    sfx.playerDown();

    if (this.siege) {
      const ps = this.siege.playerState;
      ps.deaths += 1;
      ps.recallTimer = 0;
      ps.aegisReflectTimer = 0;
      ps.smokeSpeedTimer = 0;
      ps.markedTimer = 0;
      if (attackerId) {
        const ae = this.enemies.find((e) => e.id === attackerId);
        if (ae && ae.siegeUnitKind === 'hero') {
          this.awardSiegeHeroKill(attackerId, 150, 130, true);
        }
      }
      this.status = 'RESPAWNING';
      this.respawnTimer = computeSiegeRespawnSeconds(this.siege.matchTime, this.siege.suddenDeath);
      this.spawnBurst(p.x, p.y, FACTIONS[p.faction].accentHex, 16);
      this.emitHud();
      return;
    }

    p.lives -= 1;

    const droppedFirst = this.dropWeapon(p.weapons[0], p.x, p.y);
    const secondX = droppedFirst ? clamp(p.x + 18, TILE * 0.5, this.map.width - TILE * 0.5) : p.x;
    this.dropWeapon(p.weapons[1], secondX, p.y);

    if (p.lives > 0) {
      this.status = 'RESPAWNING';
      this.respawnTimer = RESPAWN_DELAY_SECONDS;
      this.spawnBurst(p.x, p.y, FACTIONS[p.faction].accentHex, 16);
    } else if (this.multiplayer?.role === 'host') {
      const anyRemoteHumanActive = [...this.remoteHumans.values()].some(
        (rt) => rt.lives > 0 || this.enemies.some((e) => e.id === rt.entityId && e.hp > 0)
      );
      if (anyRemoteHumanActive) {
        this.spawnBurst(p.x, p.y, FACTIONS[p.faction].accentHex, 16);
        this.checkVictoryCondition();
      } else {
        this.status = 'GAME_OVER';
        sfx.defeat();
      }
    } else {
      this.status = 'GAME_OVER';
      sfx.defeat();
    }
    this.emitHud();
  }

  private respawnPlayer() {
    const p = this.player;
    this.status = 'PLAYING';
    this.clearInputs();
    sfx.playerRespawn();
    for (const enemy of this.enemies) {
      if (enemy.visibleTargetId !== 'player') continue;
      enemy.visibleTargetId = null;
      enemy.chargingMelee = false;
      enemy.chargeReady = false;
    }
    const spawnPt = this.siege
      ? this.siege.spec.fountains[p.faction === 'shadow' ? 'shadow' : 'royal']
      : this.map.factionSpawns[p.faction][0];
    p.x = spawnPt.x;
    p.y = spawnPt.y;
    p.vx = 0;
    p.vy = 0;
    p.elevation = this.getWalkableElevation(p.x, p.y);
    if (this.siege) {
      const loadout = this.siege.playerState.loadout;
      const g = ALL_GUNS_BY_ID.get(loadout.gunId) || DEFAULT_PISTOL;
      const m = ALL_MELEES_BY_ID.get(loadout.meleeId) || DEFAULT_KNIFE;
      p.weapons = [equipGun(g), { type: 'melee', def: m, durability: m.kind === 'shield' ? 100 : 0 }];
      p.maxHp = computeSiegeMaxHp(this.siege.playerState);
      p.reserveAmmo = p.maxReserveAmmo;
    } else {
      p.weapons = [defaultWeaponForHand(0), defaultWeaponForHand(1)];
      p.reserveAmmo = 30;
    }
    p.activeHand = 0;
    p.swapTimer = 0;
    p.swapDuration = 0;
    p.attackAnimTimer = 0;
    p.attackAnimDuration = 0;
    p.attackAnimKind = null;
    p.attackCooldown = 0;
    p.royalShieldTimer = 0;
    p.eagleEyeTimer = 0;
    p.shadowCloneTimer = 0;
    p.vampireTimer = 0;
    p.shrinkTimer = 0;
    p.giantTimer = 0;
    p.blindTimer = 0;
    p.blindDuration = 0;
    p.freezeTimer = 0;
    p.sizeScale = 1;
    this.actorSkillVisuals.delete(p);
    p.radius = p.baseRadius;
    p.hp = p.maxHp;
    p.qi = p.maxQi;
    this.resetGunFeedback();
    this.distanceSinceStep = 0;
    p.moveIntensity = 0;
    p.delayCancelReady = false;
    p.comboEmpowerTimer = 0;
    p.invulnTimer = 2.4;

    this.cameraLookOffset = { x: 0, y: 0 };
    const respawnCam = this.clampCameraToMap(p.x, p.y, this.viewport.width, this.viewport.height);
    this.camera.x = respawnCam.x;
    this.camera.y = respawnCam.y;
    this.spawnBurst(p.x, p.y, '#FFFFFF', 14);
    this.showBanner(
      this.siege ? '泉水復活！滿血滿彈重返戰場！' : `出生點復活！變回小槍／小刀 · 剩餘生命：${p.lives} 條`,
      2.5
    );
    this.emitHud();
  }

  private pickRandomArchetype(): EnemyArchetype {
    const r = Math.random();
    if (r > 0.78) return 'heavy';
    if (r > 0.58) return 'phantom';
    if (r > 0.38) return 'sniper';
    if (r > 0.18) return 'rusher';
    return 'trooper';
  }

  /**
   * 電腦士兵標準化：全部固定 100 血，外觀與名稱直接從所屬陣營角色池選取，
   * 出身一律配備「制式小槍 + 戰術小刀」，後續可透過尋路主動拾取地圖上的武器並依戰況邏輯切換武器！
   */
  private createEnemy(
    arch: EnemyArchetype,
    faction: FactionId,
    isAllyFlag: boolean,
    x: number,
    y: number
  ): EnemyEntity {
    const facColor = FACTIONS[faction].accentHex;
    const roster = FACTION_CHARACTERS[faction];
    const usedIds = new Set<string>(
      this.enemies.filter((oe) => oe.faction === faction).map((oe) => oe.characterSkin.id)
    );
    if (this.player.faction === faction) {
      usedIds.add(this.player.characterSkin.id);
    }
    const availableSkins = roster.filter((c) => !usedIds.has(c.id));
    const pool = availableSkins.length > 0 ? availableSkins : roster;
    const pickedSkin = pool[Math.floor(Math.random() * pool.length)];

    const speedPresets: Record<EnemyArchetype, number> = {
      trooper: 148,
      rusher: 162,
      sniper: 142,
      phantom: 158,
      heavy: 140,
    };

    const baseSpeed = speedPresets[arch];
    const entityId = uid('enemy');
    const trulyAlly = isAllyFlag && faction !== 'mercenary' && faction === this.player.faction;
    const elev = this.getWalkableElevation(x, y);
    return {
      id: entityId,
      name: pickedSkin.name,
      archetype: arch,
      faction,
      isAlly: trulyAlly,
      activeHand: 0,
      weapons: [defaultWeaponForHand(0), defaultWeaponForHand(1)],
      swapTimer: 0,
      swapDuration: 0,
      x,
      y,
      vx: 0,
      vy: 0,
      baseRadius: CHAR_BASE_RADIUS,
      radius: CHAR_BASE_RADIUS,
      sizeScale: 1,
      angle: 0,
      walkPhase: 0,
      moveIntensity: 0,
      elevation: elev,
      hp: 100, // 所有電腦角色皆為 100 血
      maxHp: 100,
      qi: 100,
      maxQi: 100,
      chargingMelee: false,
      chargeReady: false,
      speed: baseSpeed,
      attackCooldown: 0.7 + Math.random() * 0.5,
      aiTimer: Math.random() * 2,
      lastSeenTargetPos: null,
      alertTimer: 0,
      hasLosToTarget: false,
      visibleTargetId: null,
      reactionTimer: 0,
      focusedTargetId: null,
      aggroLockTimer: 0,
      pathTiles: [],
      pathTimer: 0,
      patrolAnchor: { x, y },
      patrolTarget: null,
      patrolTimer: 0,
      royalShieldTimer: 0,
      eagleEyeTimer: 0,
      shadowCloneTimer: 0,
      vampireTimer: 0,
      shrinkTimer: 0,
      giantTimer: 0,
      blindTimer: 0,
      stunTimer: 0,
      freezeTimer: 0,
      hitFlash: 0,
      gunfireTimer: 0,
      crosshairBloom: 0,
      bloomDelayTimer: 0,
      lastAimAngle: 0,
      attackAnimTimer: 0,
      attackAnimDuration: 0,
      attackAnimKind: null,
      color: facColor,
      characterSkin: pickedSkin,
    };
  }

  private getEnemyHandByType(e: EnemyEntity, type: 'gun' | 'melee'): WeaponHand | -1 {
    if (e.weapons[0].type === type) return 0;
    if (e.weapons[1].type === type) return 1;
    return -1;
  }

  private getEnemyGun(e: EnemyEntity): Extract<EquippedWeapon, { type: 'gun' }> | null {
    const active = e.weapons[e.activeHand];
    if (active.type === 'gun') return active;
    const other = e.weapons[e.activeHand === 0 ? 1 : 0];
    return other.type === 'gun' ? other : null;
  }

  private getEnemyMelee(e: EnemyEntity): Extract<EquippedWeapon, { type: 'melee' }> | null {
    const active = e.weapons[e.activeHand];
    if (active.type === 'melee') return active;
    const other = e.weapons[e.activeHand === 0 ? 1 : 0];
    return other.type === 'melee' ? other : null;
  }

  private getLightestEnemyHand(e: EnemyEntity): WeaponHand {
    return e.weapons[1].def.moveSpeedMult > e.weapons[0].def.moveSpeedMult ? 1 : 0;
  }

  private switchEnemyHand(e: EnemyEntity, targetHand: WeaponHand) {
    if (e.activeHand === targetHand) return;
    const prevWeapon = e.weapons[e.activeHand];
    if (prevWeapon.type === 'gun') {
      prevWeapon.reloadTimer = 0;
    }
    e.activeHand = targetHand;
    e.crosshairBloom = 0;
    e.bloomDelayTimer = 0;
    e.chargingMelee = false;
    e.chargeReady = false;
    const swapDur = getWeaponSwapDuration(e.weapons[targetHand].def.kind);
    e.swapDuration = swapDur;
    e.swapTimer = swapDur;
    e.attackCooldown = Math.max(e.attackCooldown, swapDur);
  }

  private isPickupEligibleForEnemy(e: EnemyEntity, pk: PickupItem): boolean {
    if (pk.kind === 'gun' && pk.gunDef) {
      return pk.gunDef.kind !== 'pistol' && e.weapons.some((w) => w.def.kind === 'pistol');
    }
    if (pk.kind === 'melee' && pk.meleeDef) {
      return pk.meleeDef.kind !== 'knife' && e.weapons.some((w) => w.def.kind === 'knife');
    }
    return false;
  }

  private findNearestEligibleWeaponPickup(e: EnemyEntity): PickupItem | null {
    if (!e.weapons.some((w) => w.def.kind === 'pistol' || w.def.kind === 'knife')) return null;
    let best: PickupItem | null = null;
    let bestD = Infinity;
    for (const pk of this.pickups) {
      if (!this.isPickupEligibleForEnemy(e, pk)) continue;
      const d = dist(e.x, e.y, pk.x, pk.y);
      if (d < bestD) {
        bestD = d;
        best = pk;
      }
    }
    return best;
  }

  private enemyTryPickupWeapon(e: EnemyEntity) {
    for (let i = 0; i < this.pickups.length; i++) {
      const pk = this.pickups[i];
      if (!this.isPickupEligibleForEnemy(e, pk)) continue;
      if (dist(e.x, e.y, pk.x, pk.y) <= e.radius + 16) {
        this.pickups.splice(i, 1);
        if (pk.kind === 'gun' && pk.gunDef) {
          const targetHand: WeaponHand =
            e.weapons[0].def.kind === 'pistol' ? 0 : e.weapons[1].def.kind === 'pistol' ? 1 : 0;
          this.dropWeapon(e.weapons[targetHand], pk.x, pk.y);
          e.weapons[targetHand] = equipGun(pk.gunDef, pk.ammoInMag ?? pk.gunDef.magSize);
          if (e.activeHand === targetHand) {
            e.crosshairBloom = 0;
            e.bloomDelayTimer = 0;
            e.chargingMelee = false;
            e.chargeReady = false;
          }
        } else if (pk.kind === 'melee' && pk.meleeDef) {
          const targetHand: WeaponHand =
            e.weapons[1].def.kind === 'knife' ? 1 : e.weapons[0].def.kind === 'knife' ? 0 : 1;
          this.dropWeapon(e.weapons[targetHand], pk.x, pk.y);
          e.weapons[targetHand] = {
            type: 'melee',
            def: pk.meleeDef,
            durability: pk.meleeDef.kind === 'shield' ? clamp(pk.durability ?? 100, 1, 100) : 0,
          };
        }
        e.pathTiles = [];
        e.pathTimer = 0;
        break;
      }
    }
  }

  private emitNetSfx(
    kind: Extract<NetTransientEvent, { k: 'sfx' }>['kind'],
    x: number,
    y: number,
    sub?: string,
    flag?: boolean
  ) {
    if (this.multiplayer?.role !== 'host') return;
    this.netEvents.push({
      k: 'sfx',
      kind,
      x: round1(x),
      y: round1(y),
      ...(sub !== undefined ? { sub } : {}),
      ...(flag !== undefined ? { flag } : {}),
    });
  }

  private pushBeam(beam: BeamTracer) {
    this.beams.push(beam);
    if (this.multiplayer?.role === 'host') {
      this.netEvents.push({
        k: 'beam',
        x1: round1(beam.x1),
        y1: round1(beam.y1),
        x2: round1(beam.x2),
        y2: round1(beam.y2),
        color: beam.color,
        life: beam.life,
        w: beam.width,
      });
    }
  }

  private pushSlash(slash: SlashEffect) {
    this.slashes.push(slash);
    if (this.multiplayer?.role === 'host') {
      this.netEvents.push({
        k: 'slash',
        x: round1(slash.x),
        y: round1(slash.y),
        angle: Number(slash.angle.toFixed(3)),
        arc: Number(slash.arc.toFixed(3)),
        reach: round1(slash.reach),
        color: slash.color,
        life: slash.life,
        ult: slash.isUltimate,
        style: slash.style,
      });
    }
  }

  private spawnBurst(x: number, y: number, color: string, count: number) {
    if (this.multiplayer?.role === 'host') {
      this.netEvents.push({ k: 'burst', x: round1(x), y: round1(y), color, count });
    }
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = 60 + Math.random() * 200;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        size: 2 + Math.random() * 3.5,
        color,
        life: 0.25 + Math.random() * 0.25,
        maxLife: 0.5,
      });
    }
  }

  private spawnText(x: number, y: number, text: string, color: string, scale = 1, subtle = false) {
    if (this.multiplayer?.role === 'host') {
      this.netEvents.push({
        k: 'text',
        x: round1(x),
        y: round1(y),
        text,
        color,
        scale,
        ...(subtle ? { subtle: true } : {}),
      });
    }
    this.floatingTexts.push({
      x,
      y,
      vy: -38,
      text,
      color,
      life: 0.85,
      maxLife: 0.85,
      scale,
      subtle,
    });
  }

  private isBattleActive() {
    return this.status === 'PLAYING' || this.status === 'RESPAWNING';
  }

  private updateReloads(dt: number) {
    const p = this.player;
    const weapon = p.weapons[p.activeHand];
    if (weapon.type !== 'gun' || weapon.reloadTimer <= 0) return;

    const previousProgress = 1 - weapon.reloadTimer / weapon.def.reloadTime;
    weapon.reloadTimer = Math.max(0, weapon.reloadTimer - dt);
    const progress = 1 - weapon.reloadTimer / weapon.def.reloadTime;
    for (const cue of RELOAD_CUES) {
      if (previousProgress < cue.progress && progress >= cue.progress) {
        sfx.reload(weapon.def.kind, cue.phase);
      }
    }
    if (weapon.reloadTimer > 0) return;

    const wholeReserve = Math.floor(p.reserveAmmo);
    const needed = Math.min(weapon.def.magSize - weapon.ammoInMag, wholeReserve);
    weapon.ammoInMag += needed;
    p.reserveAmmo = Math.max(0, p.reserveAmmo - needed);
    sfx.reload(weapon.def.kind, 'ready');
    this.emitHud();
  }

  private emitChargeReadyParticles(
    actor: { x: number; y: number; radius: number; faction: FactionId },
    dt: number
  ) {
    if (Math.random() >= dt * 15 || this.particles.length >= 240) return;
    const angle = Math.random() * Math.PI * 2;
    const spawnDist = actor.radius * (0.75 + Math.random() * 0.45);
    const factionColor =
      actor.faction === 'royal' ? '#7DD3FC' : actor.faction === 'shadow' ? '#FB7185' : '#FBBF24';
    this.particles.push({
      x: actor.x + Math.cos(angle) * spawnDist,
      y: actor.y + Math.sin(angle) * spawnDist,
      vx: Math.cos(angle) * (14 + Math.random() * 24),
      vy: -22 - Math.random() * 28 + Math.sin(angle) * 10,
      size: 2 + Math.random() * 2.4,
      color: Math.random() < 0.6 ? '#FEF08A' : factionColor,
      life: 0.34 + Math.random() * 0.24,
      maxLife: 0.58,
    });
  }

  private updatePlayerQi(dt: number, repSpeedMult: number) {
    const p = this.player;
    if (!this.chargeSessionAllowed) {
      const rate = this.qiFastRefund ? 360 : QI_RATE.recover * repSpeedMult;
      p.qi = Math.min(p.maxQi, p.qi + rate * dt);
      if (this.qiFastRefund && p.qi >= p.maxQi - 0.01) {
        p.qi = p.maxQi;
        this.qiFastRefund = false;
      }
      return;
    }
    this.qiFastRefund = false;
    if (p.chargeReady) return;

    let chargeDt = dt;
    if (!p.chargingMelee) {
      this.meleeHeldSeconds += dt;
      if (this.meleeHeldSeconds < MELEE_CHARGE_HOLD_SECONDS || p.swapTimer > 0) return;
      p.chargingMelee = true;
      chargeDt = Math.min(dt, this.meleeHeldSeconds - MELEE_CHARGE_HOLD_SECONDS);
      sfx.setMeleeCharge(0);
    }

    p.qi = Math.max(0, p.qi - QI_RATE.charge * repSpeedMult * chargeDt);
    if (p.qi === 0) {
      p.chargeReady = true;
      sfx.setMeleeCharge(null);
      sfx.meleeReady();
      this.spawnBurst(p.x, p.y, '#FDE047', 16);
    } else {
      sfx.setMeleeCharge(1 - p.qi / p.maxQi);
    }
  }

  private clearTimedSkillsOnFreeze(unit: {
    royalShieldTimer: number;
    eagleEyeTimer: number;
    shadowCloneTimer: number;
    vampireTimer: number;
    shrinkTimer: number;
    giantTimer: number;
    chargingMelee: boolean;
    chargeReady: boolean;
    sizeScale: number;
    radius: number;
    baseRadius: number;
  }) {
    unit.royalShieldTimer = 0;
    unit.eagleEyeTimer = 0;
    unit.shadowCloneTimer = 0;
    unit.vampireTimer = 0;
    unit.shrinkTimer = 0;
    unit.giantTimer = 0;
    unit.chargingMelee = false;
    unit.chargeReady = false;
    unit.sizeScale = 1;
    unit.radius = unit.baseRadius;
  }

  private applyIceVentFreezeCheck(
    unit: {
      x: number;
      y: number;
      elevation: number;
      freezeTimer: number;
      royalShieldTimer: number;
      eagleEyeTimer: number;
      shadowCloneTimer: number;
      vampireTimer: number;
      shrinkTimer: number;
      giantTimer: number;
      chargingMelee: boolean;
      chargeReady: boolean;
      sizeScale: number;
      radius: number;
      baseRadius: number;
    },
    isPlayer: boolean
  ) {
    const vents = this.map.iceVents;
    if (!vents || vents.length === 0) return;
    for (const iv of vents) {
      const vx = (iv.gx + 0.5) * TILE;
      const vy = (iv.gy + 0.5) * TILE;
      const ventElev = this.map.tileGrid[iv.gy]?.[iv.gx]?.elev ?? 0;
      if (dist(unit.x, unit.y, vx, vy) <= TILE * 0.46 && Math.abs(unit.elevation - ventElev) <= 0.5) {
        const wasFrozen = unit.freezeTimer > 0;
        unit.freezeTimer = 5.0;
        this.clearTimedSkillsOnFreeze(unit);
        if (isPlayer) {
          this.cancelMeleeCharge(false);
          if (!wasFrozen) {
            this.spawnText(unit.x, unit.y - 38, '冰凍 5s', '#38BDF8', 1.15);
            this.emitHud();
          }
        } else if (!wasFrozen) {
          this.spawnText(unit.x, unit.y - 34, '冰凍 5s', '#38BDF8', 1.05);
        }
        return;
      }
    }
  }

  private updatePlayer(dt: number) {
    const p = this.player;
    p.attackCooldown = Math.max(0, p.attackCooldown - dt);
    p.gunfireTimer = Math.max(0, p.gunfireTimer - dt);
    p.swapTimer = Math.max(0, p.swapTimer - dt);
    p.attackAnimTimer = Math.max(0, p.attackAnimTimer - dt);
    if (p.attackAnimTimer === 0) p.attackAnimKind = null;
    p.freezeTimer = Math.max(0, p.freezeTimer - dt);
    p.royalShieldTimer = Math.max(0, p.royalShieldTimer - dt);
    p.eagleEyeTimer = Math.max(0, p.eagleEyeTimer - dt);
    p.shadowCloneTimer = Math.max(0, p.shadowCloneTimer - dt);
    p.vampireTimer = Math.max(0, p.vampireTimer - dt);
    p.shrinkTimer = Math.max(0, p.shrinkTimer - dt);
    p.giantTimer = Math.max(0, p.giantTimer - dt);
    p.blindTimer = Math.max(0, p.blindTimer - dt);
    if (p.blindTimer === 0) p.blindDuration = 0;
    p.invulnTimer = Math.max(0, p.invulnTimer - dt);
    p.comboEmpowerTimer = Math.max(0, p.comboEmpowerTimer - dt);
    if (p.comboTimer > 0) {
      p.comboTimer -= dt;
      if (p.comboTimer <= 0) p.comboCount = 0;
    }

    if (p.freezeTimer > 0) {
      this.clearTimedSkillsOnFreeze(p);
      this.cancelMeleeCharge(false);
    }

    p.sizeScale = p.shrinkTimer > 0 ? 0.62 : p.giantTimer > 0 ? 1.32 : 1.0;
    p.radius = p.baseRadius * p.sizeScale;

    // 經典 4:3 戰術視窗（左右約 16 格、上下約 12 格；鷹眼不縮放視野，改為純前移偵察）
    this.camera.zoom = this.getBaseZoom(this.viewport.width, this.viewport.height);

    // 聲望越高，集氣與回氣速度越快（依當前出戰陣營之獨立聲望計算；冰凍期間無法集氣）
    const activeRep = p.reputations[p.faction];
    p.reputation = activeRep;
    let repSpeedMult = getReputationQiMultiplier(activeRep);
    if (this.siege) {
      const ps = this.siege.playerState;
      repSpeedMult *= 1 + (ps.upgrades.core ?? 0) * 0.14 + (ps.loadout.passiveId === 'shadow_swift_foot' ? 0.25 : 0);
    }
    if (p.freezeTimer > 0) {
      this.cancelMeleeCharge(false);
    } else {
      this.updatePlayerQi(dt, repSpeedMult);
    }

    const weapon = p.weapons[p.activeHand];
    const isSniper = weapon.type === 'gun' && weapon.def.kind === 'sniper';
    if (isSniper && this.crosshairBloomDelay > 0) {
      this.crosshairBloomDelay = Math.max(0, this.crosshairBloomDelay - dt);
    } else {
      const recoveryRate = isSniper ? SNIPER_AIM.bloomRecovery : GUN_AIM.bloomRecovery;
      this.crosshairBloom = Math.max(0, this.crosshairBloom - recoveryRate * dt);
    }
    this.rifleRecoilAngle *= Math.exp(-RIFLE_RECOIL.recovery * dt);

    this.updateReloads(dt);

    const mv = this.getMoveVector();
    if (Math.hypot(mv.x, mv.y) > 0.1) {
      this.framePushInputs.push({
        id: 'player',
        isPlayer: true,
        faction: p.faction,
        x: p.x,
        y: p.y,
        radius: p.radius,
        elevation: p.elevation,
        dirX: mv.x,
        dirY: mv.y,
      });
    }
    const weaponSpeedMult =
      this.siege && weapon.type === 'gun'
        ? getSiegeGunProfile(weapon.def.kind).moveSpeedMult
        : weapon.def.moveSpeedMult;
    const freezeSpeedMult = p.freezeTimer > 0 ? 0.9 : 1.0;
    const siegeSpeedMult = this.siege ? computeSiegeMoveSpeedMult(this.siege.playerState) : 1.0;
    const baseSpeed = PLAYER_MOVEMENT.speed * weaponSpeedMult * freezeSpeedMult * siegeSpeedMult;
    const prevPlayerX = p.x;
    const prevPlayerY = p.y;
    const moved = this.moveCharacterWithElevation(
      p.x,
      p.y,
      p.elevation,
      mv.x * baseSpeed * dt,
      mv.y * baseSpeed * dt,
      p.radius
    );
    p.x = moved.x;
    p.y = moved.y;
    p.elevation = moved.elevation;
    p.vx = dt > 0 ? (p.x - prevPlayerX) / dt : 0;
    p.vy = dt > 0 ? (p.y - prevPlayerY) / dt : 0;
    if (this.siege && Math.hypot(p.x - prevPlayerX, p.y - prevPlayerY) > 1.0) {
      this.siege.playerState.recallTimer = 0;
    }

    this.applyIceVentFreezeCheck(p, true);

    const { x: worldMouseX, y: worldMouseY } = this.getWorldPointer();
    p.angle = Math.atan2(worldMouseY - p.y, worldMouseX - p.x);
    const playerMovedDist = dist(prevPlayerX, prevPlayerY, p.x, p.y);
    if (playerMovedDist > 0.12) {
      if (isSniper && weapon.type === 'gun') {
        const walkCap = Math.min(weapon.def.maxCrosshair - weapon.def.baseCrosshair, SNIPER_AIM.bodyMoveBloomCap);
        if (this.crosshairBloom <= walkCap) {
          this.crosshairBloom = Math.min(walkCap, this.crosshairBloom + playerMovedDist * SNIPER_AIM.bodyMoveScale);
          this.crosshairBloomDelay = Math.max(this.crosshairBloomDelay, SNIPER_AIM.settleDelaySeconds);
        }
      }
      this.distanceSinceStep += playerMovedDist;
      if (this.distanceSinceStep >= PLAYER_MOVEMENT.stepDistance) {
        this.distanceSinceStep %= PLAYER_MOVEMENT.stepDistance;
        sfx.footstep(this.getFootstepSurface(p.x, p.y));
      }
      p.walkPhase += playerMovedDist * 0.085;
      p.moveIntensity = Math.min(1, p.moveIntensity + dt * 10);
    } else {
      p.moveIntensity = Math.max(0, p.moveIntensity - dt * 10);
    }

    if (this.mouseDown && weapon.type === 'gun' && weapon.def.kind === 'rifle' && weapon.ammoInMag > 0) {
      this.tryAttack();
    }
  }

  public update(dt: number, canvasWidth: number, canvasHeight: number) {
    this.viewport.width = canvasWidth;
    this.viewport.height = canvasHeight;
    if (this.multiplayer?.role === 'client') {
      this.updateClientView(dt, canvasWidth, canvasHeight);
      return;
    }
    if (this.status === 'VICTORY' || this.status === 'GAME_OVER') {
      this.updatePostMatchVisuals(dt);
      return;
    }
    if (!this.isBattleActive()) return;

    const respawningAtFrameStart = this.status === 'RESPAWNING';
    this.time += dt;
    if (this.skillTraces.length > 0) {
      this.skillTraces = this.skillTraces.filter((trace) => this.time - trace.startedAt < trace.duration);
    }
    this.framePushInputs = [];
    if (this.bannerTimer > 0) this.bannerTimer = Math.max(0, this.bannerTimer - dt);
    if (this.activeSkillBannerTimer > 0) this.activeSkillBannerTimer = Math.max(0, this.activeSkillBannerTimer - dt);
    if (this.camera.shake > 0) this.camera.shake = Math.max(0, this.camera.shake - dt * 26);

    if (!respawningAtFrameStart && this.player.hp > 0) this.updatePlayer(dt);
    if (this.multiplayer?.role === 'host') {
      this.tickRemoteHumanRespawns(dt);
    }

    this.map.ammoSpawns.forEach((as, idx) => {
      if (!as.active) {
        as.respawnTimer -= dt;
        if (as.respawnTimer <= 0) {
          as.active = true;
          as.respawnTimer = 0;
          this.pickups.push({
            id: uid('ammo_pad'),
            x: as.x,
            y: as.y,
            kind: 'ammo',
            label: '彈藥箱 (+30發)',
            color: '#60A5FA',
            amount: 30,
            bobPhase: 0,
            ammoSpawnIndex: idx,
          });
        }
      }
    });

    if (this.siege) {
      this.updateSiegeMode(dt);
      if (!this.isBattleActive()) return;
    } else {
      // 定期遞補陣亡的各陣營 10 人編制兵力（同陣營場上最多 2 人）
      this.spawnStaggerTimer += dt;
      if (this.spawnStaggerTimer >= 0.65) {
        this.spawnStaggerTimer = 0;
        this.refillFieldUpToCap();
      }
    }

    this.updateEnemies(dt);
    if (this.player.hp > 0) {
      this.updateActorSkillVisuals(this.player, dt);
      if (this.player.chargeReady) this.emitChargeReadyParticles(this.player, dt);
    }
    for (const enemy of this.enemies) {
      this.updateActorSkillVisuals(enemy, dt);
      if (enemy.hp > 0 && enemy.chargeReady) this.emitChargeReadyParticles(enemy, dt);
    }
    if (!this.isBattleActive()) return;
    this.updatePushableIceBlocks(dt);
    if (!this.isBattleActive()) return;
    this.updateProjectiles(dt);
    if (!this.isBattleActive()) return;
    this.checkVictoryCondition();

    this.beams = this.beams.filter((b) => {
      b.life -= dt;
      return b.life > 0;
    });
    const iceVents = this.map.iceVents;
    if (iceVents && iceVents.length > 0) {
      for (const iv of iceVents) {
        if (Math.random() < dt * 7.5 && this.particles.length < 220) {
          const vx = (iv.gx + 0.5) * TILE + (Math.random() - 0.5) * 14;
          const vy = (iv.gy + 0.5) * TILE + (Math.random() - 0.5) * 10;
          const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
          const spd = 22 + Math.random() * 34;
          this.particles.push({
            x: vx,
            y: vy,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd,
            size: 2.2 + Math.random() * 2.8,
            color: Math.random() < 0.5 ? '#E0F2FE' : '#7DD3FC',
            life: 0.45 + Math.random() * 0.35,
            maxLife: 0.8,
          });
        }
      }
    }
    const campfires = this.map.campfires;
    if (campfires && campfires.length > 0) {
      for (const cf of campfires) {
        if (Math.random() < dt * 6.5 && this.particles.length < 220) {
          const fx = (cf.gx + 0.5) * TILE + (Math.random() - 0.5) * 10;
          const fy = (cf.gy + 0.5) * TILE + (Math.random() - 0.5) * 8;
          this.particles.push({
            x: fx,
            y: fy,
            vx: (Math.random() - 0.5) * 16,
            vy: -(24 + Math.random() * 28),
            size: 1.8 + Math.random() * 2.2,
            color: Math.random() < 0.5 ? '#FBBF24' : '#F97316',
            life: 0.4 + Math.random() * 0.3,
            maxLife: 0.7,
          });
        }
      }
    }
    this.slashes = this.slashes.filter((s) => {
      s.life -= dt;
      return s.life > 0;
    });
    this.particles = this.particles.filter((pt) => {
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.92;
      pt.vy *= 0.92;
      pt.life -= dt;
      return pt.life > 0;
    });
    this.floatingTexts = this.floatingTexts.filter((ft) => {
      ft.y += ft.vy * dt;
      ft.life -= dt;
      return ft.life > 0;
    });

    for (const pk of this.pickups) {
      pk.bobPhase += dt * 4;
    }

    if (respawningAtFrameStart) {
      this.respawnTimer = Math.max(0, this.respawnTimer - dt);
      if (this.respawnTimer === 0) {
        this.respawnPlayer();
      }
    }
    if (this.status === 'PLAYING' || this.status === 'RESPAWNING') {
      this.updateCamera(dt);
    }

    this.hudEmitTimer += dt;
    if (this.hudEmitTimer >= 0.09) {
      this.hudEmitTimer = 0;
      this.emitHud();
    }
  }

  private updatePostMatchVisuals(dt: number) {
    this.time += dt;
    if (this.skillTraces.length > 0) {
      this.skillTraces = this.skillTraces.filter((trace) => this.time - trace.startedAt < trace.duration);
    }
    if (this.bannerTimer > 0) this.bannerTimer = Math.max(0, this.bannerTimer - dt);
    if (this.activeSkillBannerTimer > 0) this.activeSkillBannerTimer = Math.max(0, this.activeSkillBannerTimer - dt);
    if (this.camera.shake > 0) this.camera.shake = Math.max(0, this.camera.shake - dt * 26);

    // Let in-progress reloads and weapon animations finish cleanly without accepting new player or AI actions.
    const p = this.player;
    if (p.hp > 0) {
      this.updateReloads(dt);
      p.gunfireTimer = Math.max(0, p.gunfireTimer - dt);
      p.swapTimer = Math.max(0, p.swapTimer - dt);
      p.attackAnimTimer = Math.max(0, p.attackAnimTimer - dt);
      if (p.attackAnimTimer === 0) p.attackAnimKind = null;
      this.updateActorSkillVisuals(p, dt);
      if (p.chargeReady) this.emitChargeReadyParticles(p, dt);
    }
    for (const enemy of this.enemies) {
      enemy.gunfireTimer = Math.max(0, enemy.gunfireTimer - dt);
      enemy.swapTimer = Math.max(0, enemy.swapTimer - dt);
      enemy.attackAnimTimer = Math.max(0, enemy.attackAnimTimer - dt);
      if (enemy.attackAnimTimer === 0) enemy.attackAnimKind = null;
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
      const w = enemy.weapons[enemy.activeHand];
      if (w.type === 'gun' && w.reloadTimer > 0) {
        w.reloadTimer = Math.max(0, w.reloadTimer - dt);
        if (w.reloadTimer === 0) {
          w.ammoInMag = w.def.magSize;
        }
      }
      this.updateActorSkillVisuals(enemy, dt);
      if (enemy.hp > 0 && enemy.chargeReady) this.emitChargeReadyParticles(enemy, dt);
    }

    // Keep projectiles (Black Dragon Wave, Light Orbs) moving and bouncing visually, with ZERO damage.
    this.updateProjectiles(dt, false);

    this.beams = this.beams.filter((b) => {
      b.life -= dt;
      return b.life > 0;
    });
    const iceVents = this.map.iceVents;
    if (iceVents && iceVents.length > 0) {
      for (const iv of iceVents) {
        if (Math.random() < dt * 7.5 && this.particles.length < 220) {
          const vx = (iv.gx + 0.5) * TILE + (Math.random() - 0.5) * 14;
          const vy = (iv.gy + 0.5) * TILE + (Math.random() - 0.5) * 10;
          const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
          const spd = 22 + Math.random() * 34;
          this.particles.push({
            x: vx,
            y: vy,
            vx: Math.cos(ang) * spd,
            vy: Math.sin(ang) * spd,
            size: 2.2 + Math.random() * 2.8,
            color: Math.random() < 0.5 ? '#E0F2FE' : '#7DD3FC',
            life: 0.45 + Math.random() * 0.35,
            maxLife: 0.8,
          });
        }
      }
    }
    const campfires = this.map.campfires;
    if (campfires && campfires.length > 0) {
      for (const cf of campfires) {
        if (Math.random() < dt * 6.5 && this.particles.length < 220) {
          const fx = (cf.gx + 0.5) * TILE + (Math.random() - 0.5) * 10;
          const fy = (cf.gy + 0.5) * TILE + (Math.random() - 0.5) * 8;
          this.particles.push({
            x: fx,
            y: fy,
            vx: (Math.random() - 0.5) * 16,
            vy: -(24 + Math.random() * 28),
            size: 1.8 + Math.random() * 2.2,
            color: Math.random() < 0.5 ? '#FBBF24' : '#F97316',
            life: 0.4 + Math.random() * 0.3,
            maxLife: 0.7,
          });
        }
      }
    }
    this.slashes = this.slashes.filter((s) => {
      s.life -= dt;
      return s.life > 0;
    });
    this.particles = this.particles.filter((pt) => {
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.92;
      pt.vy *= 0.92;
      pt.life -= dt;
      return pt.life > 0;
    });
    this.floatingTexts = this.floatingTexts.filter((ft) => {
      ft.y += ft.vy * dt;
      ft.life -= dt;
      return ft.life > 0;
    });
    for (const pk of this.pickups) {
      pk.bobPhase += dt * 4;
    }

    this.hudEmitTimer += dt;
    if (this.hudEmitTimer >= 0.12) {
      this.hudEmitTimer = 0;
      this.emitHud();
    }
  }

  private isSpectating(): boolean {
    // 僅在經典模式三命全數耗盡且戰局仍在進行中時，才開放自由視角與觀戰切換
    return this.status === 'PLAYING' && this.player.hp <= 0 && !this.siege && this.player.lives <= 0;
  }

  private getSpectatorCandidates(): EnemyEntity[] {
    const alive = this.enemies.filter((e) => e.hp > 0);
    const myFaction = this.player.faction;
    return alive.sort((a, b) => {
      const rank = (e: EnemyEntity) => {
        const sameFac = myFaction !== 'mercenary' && e.faction === myFaction;
        if (e.isHumanPlayer && sameFac) return 0;
        if (e.isHumanPlayer) return 1;
        if (sameFac) return 2;
        return 3;
      };
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  }

  public cycleSpectatorTarget() {
    const candidates = this.getSpectatorCandidates();
    this.spectatorMode = 'follow';
    if (candidates.length === 0) {
      this.spectatorTargetId = null;
      return;
    }
    const idx = this.spectatorTargetId
      ? candidates.findIndex((c) => c.id === this.spectatorTargetId)
      : -1;
    const next = candidates[(idx + 1) % candidates.length];
    this.spectatorTargetId = next.id;
    this.emitHud();
  }

  private getBaseZoom(canvasWidth = this.viewport.width, canvasHeight = this.viewport.height): number {
    return Math.max(canvasWidth / (VIEWPORT_TILES_X * TILE), canvasHeight / (VIEWPORT_TILES_Y * TILE));
  }

  private updateCamera(dt: number) {
    const { width: canvasWidth, height: canvasHeight } = this.viewport;
    const p = this.player;

    if (this.status === 'RESPAWNING') {
      // 尚餘生命／等待重生倒數期間：保持視角固定於陣亡位置，不跟隨隊友或自由移動鏡頭
      this.spectatorMode = 'follow';
      this.spectatorTargetId = null;
      this.cameraLookOffset = { x: 0, y: 0 };
      return;
    }

    if (this.isSpectating()) {
      const mv = this.getMoveVector();
      const moveLen = Math.hypot(mv.x, mv.y);
      if (moveLen > 0.05) {
        if (this.spectatorMode !== 'free') {
          this.spectatorMode = 'free';
          this.emitHud();
        }
        const panSpeed = 420;
        const nextCam = this.clampCameraToMap(
          this.camera.x + (mv.x / Math.max(1, moveLen)) * panSpeed * dt,
          this.camera.y + (mv.y / Math.max(1, moveLen)) * panSpeed * dt,
          canvasWidth,
          canvasHeight
        );
        this.camera.x = nextCam.x;
        this.camera.y = nextCam.y;
        return;
      }

      if (this.spectatorMode === 'follow') {
        const candidates = this.getSpectatorCandidates();
        let target = this.spectatorTargetId
          ? candidates.find((c) => c.id === this.spectatorTargetId) ?? null
          : null;
        if (!target && candidates.length > 0) {
          target = candidates[0];
          this.spectatorTargetId = target.id;
        }
        if (target) {
          const desired = this.clampCameraToMap(target.x, target.y, canvasWidth, canvasHeight);
          const blend = Math.min(1, dt * 8);
          this.camera.x += (desired.x - this.camera.x) * blend;
          this.camera.y += (desired.y - this.camera.y) * blend;
          return;
        }
      }
      return;
    }

    // Player is alive: reset spectator state and strictly center on player (with Eagle Eye lookahead if active)
    this.spectatorMode = 'follow';
    this.spectatorTargetId = null;
    let targetLookX = 0;
    let targetLookY = 0;

    if (p.eagleEyeTimer > 0) {
      const zoom = Math.max(0.5, this.camera.zoom);
      const halfW = canvasWidth / (2 * zoom);
      const halfH = canvasHeight / (2 * zoom);
      // Use the unshifted clamped player camera so Eagle Eye pan does not feedback-loop with mouseScreen
      const baseCam = this.clampCameraToMap(p.x, p.y, canvasWidth, canvasHeight);
      const baseMouseX = (this.mouseScreen.x - canvasWidth / 2) / zoom + baseCam.x;
      const baseMouseY = (this.mouseScreen.y - canvasHeight / 2) / zoom + baseCam.y;
      const rawDx = baseMouseX - p.x;
      const rawDy = baseMouseY - p.y;
      if (Math.hypot(rawDx, rawDy) > TILE * 0.4) {
        const maxLookX = Math.max(0, halfW - 2.75 * TILE);
        const maxLookY = Math.max(0, halfH - 2.0 * TILE);
        targetLookX = clamp(rawDx * 0.72, -maxLookX, maxLookX);
        targetLookY = clamp(rawDy * 0.72, -maxLookY, maxLookY);
      }
    }

    const offsetBlend = Math.min(1, dt * (p.eagleEyeTimer > 0 ? 8 : 12));
    this.cameraLookOffset.x += (targetLookX - this.cameraLookOffset.x) * offsetBlend;
    this.cameraLookOffset.y += (targetLookY - this.cameraLookOffset.y) * offsetBlend;
    if (p.eagleEyeTimer <= 0 && Math.hypot(this.cameraLookOffset.x, this.cameraLookOffset.y) < 0.5) {
      this.cameraLookOffset.x = 0;
      this.cameraLookOffset.y = 0;
    }

    const clampedCam = this.clampCameraToMap(
      p.x + this.cameraLookOffset.x,
      p.y + this.cameraLookOffset.y,
      canvasWidth,
      canvasHeight
    );
    this.camera.x = clampedCam.x;
    this.camera.y = clampedCam.y;
  }

  private nearbySoundVolume(x: number, y: number) {
    return Math.max(0, 1 - dist(x, y, this.player.x, this.player.y) / 500);
  }

  private getFootstepSurface(x: number, y: number): FootstepSurface {
    const gx = clamp(Math.floor(x / TILE), 0, this.map.cols - 1);
    const gy = clamp(Math.floor(y / TILE), 0, this.map.rows - 1);
    const tile = this.map.tileGrid[gy]?.[gx];
    const floor = this.map.floorGrid?.[gy]?.[gx];
    if (
      tile?.style === 'wooden_plank' ||
      tile?.style === 'shrine_floor' ||
      this.map.bridges.some((bridge) => pointInRect(x, y, bridge))
    ) {
      return 'wood';
    }
    if (this.map.floatingIceTileKeys?.has(`${gx},${gy}`) || this.map.floatingIceTiles?.some((f) => f.gx === gx && f.gy === gy)) {
      return 'hard';
    }
    if (tile?.style === 'hill') return 'soft';
    if (tile?.elev === 0) {
      if (
        floor === 'grass_ground' ||
        floor === 'bamboo_moss' ||
        floor === 'shrine_dirt' ||
        floor === 'desert_sand' ||
        tile.style === 'grass_ground'
      ) {
        return 'soft';
      }
      if (floor === 'castle_stone' || floor === 'warehouse_steel' || floor === 'glacier_ice') return 'hard';
    }
    if (tile?.style === 'glacier_ice') return 'hard';
    if (tile?.style && tile.style !== 'default') return 'hard';
    return this.map.biome.endsWith('_outdoor') ? 'soft' : 'hard';
  }

  private canSlidePushableIceBlock(blk: PushableIceBlock, dir: CardinalDir): boolean {
    const delta: Record<CardinalDir, [number, number]> = {
      north: [0, -1],
      south: [0, 1],
      east: [1, 0],
      west: [-1, 0],
    };
    const [dx, dy] = delta[dir];
    const nextX = blk.x + dx * TILE;
    const nextY = blk.y + dy * TILE;
    const nextGx = Math.round(nextX / TILE);
    const nextGy = Math.round(nextY / TILE);
    if (nextGx < 0 || nextGy < 0 || nextGx + 2 > this.map.cols || nextGy + 2 > this.map.rows) {
      return false;
    }

    const nextRect = { x: nextX + 2, y: nextY + 2, w: blk.w - 4, h: blk.h - 4 };
    for (let gy = nextGy; gy < nextGy + 2; gy++) {
      for (let gx = nextGx; gx < nextGx + 2; gx++) {
        const cell = this.map.tileGrid[gy]?.[gx];
        if (!cell || Math.abs(cell.elev - blk.baseElev) > 0.01) {
          return false; // 不可推上高台、階梯差層或深坑
        }
        const cx = (gx + 0.5) * TILE;
        const cy = (gy + 0.5) * TILE;
        if (!this.isGroundWalkable(cx, cy)) return false;
        for (const st of this.map.stairs) {
          if (pointInRect(cx, cy, st)) return false;
        }
      }
    }

    const rectsOverlapLoose = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    for (const obs of this.map.obstacles) {
      if (rectsOverlapLoose(nextRect, obs)) return false;
    }
    for (const tree of this.map.trees) {
      if (rectsOverlapLoose(nextRect, tree)) return false;
    }
    for (const other of this.map.pushableIceBlocks || []) {
      if (other.id === blk.id) continue;
      if (rectsOverlapLoose(nextRect, other)) return false;
    }
    return true;
  }

  private crushUnitByIceBlock(
    target: { isPlayer: boolean; enemy?: EnemyEntity },
    pusherId: string | null,
    pusherFaction: FactionId | null
  ) {
    const p = this.player;
    if (target.isPlayer) {
      if (p.hp <= 0) return;
      const fatalDmg = Math.max(1, Math.ceil(p.hp));
      this.spawnBurst(p.x, p.y, '#7DD3FC', 18);
      this.spawnText(p.x, p.y - 34, `-${fatalDmg}`, '#EF4444', 1.25);
      p.hp = 0;
      this.camera.shake = Math.min(14, this.camera.shake + 8);
      this.handlePlayerDeath(pusherId ?? undefined);
      return;
    }
    const enemy = target.enemy;
    if (!enemy || enemy.hp <= 0) return;
    const fatalDmg = Math.max(1, Math.ceil(enemy.hp));
    this.spawnBurst(enemy.x, enemy.y, '#7DD3FC', 18);
    this.spawnText(enemy.x, enemy.y - 28, `-${fatalDmg}`, '#EF4444', 1.25);
    enemy.hp = 0;
    enemy.hitFlash = 0.16;

    const friendlyFire = pusherId !== null && pusherFaction !== null &&
      !areHostile(pusherFaction, pusherId, enemy.faction, enemy.id);
    if (pusherId === 'player' && !friendlyFire) {
      p.totalDamage += fatalDmg;
      p.score += fatalDmg;
      sfx.hit(true);
    }
    this.removeEnemy(enemy, pusherId ?? undefined, friendlyFire, 'ice');
  }

  private updatePushableIceBlocks(dt: number) {
    const blocks = this.map.pushableIceBlocks;
    if (!blocks || blocks.length === 0) return;

    const dirDelta: Record<CardinalDir, [number, number]> = {
      north: [0, -1],
      south: [0, 1],
      east: [1, 0],
      west: [-1, 0],
    };
    const PUSH_HOLD_THRESHOLD = 0.28;
    let navDirty = false;

    for (const blk of blocks) {
      if (blk.slideTimer > 0 && blk.slideDir) {
        blk.slideTimer = Math.max(0, blk.slideTimer - dt);
        const progress = 1 - blk.slideTimer / Math.max(0.01, blk.slideDuration);
        blk.x = blk.slideStartX + (blk.slideEndX - blk.slideStartX) * progress;
        blk.y = blk.slideStartY + (blk.slideEndY - blk.slideStartY) * progress;

        const [dx, dy] = dirDelta[blk.slideDir];
        const shoveUnit = (
          u: { x: number; y: number; radius: number; elevation: number },
          applyPos: (nx: number, ny: number, ne: number) => void,
          crushTarget: { isPlayer: boolean; enemy?: EnemyEntity }
        ) => {
          if (Math.abs(u.elevation - blk.baseElev) > 0.5) return;
          const padR = getMoveCheckRadius(u.radius);
          if (!resolveCircleRect(u.x, u.y, padR, blk).hit) return;

          // 計算不被冰塊重合的前緣安全位置，並檢查前方是否有牆壁／懸崖／障礙物阻擋
          let desiredOffset = 0;
          if (blk.slideDir === 'east') {
            desiredOffset = Math.max(0, blk.x + blk.w + padR + 1.5 - u.x);
          } else if (blk.slideDir === 'west') {
            desiredOffset = Math.max(0, u.x - (blk.x - padR - 1.5));
          } else if (blk.slideDir === 'south') {
            desiredOffset = Math.max(0, blk.y + blk.h + padR + 1.5 - u.y);
          } else if (blk.slideDir === 'north') {
            desiredOffset = Math.max(0, u.y - (blk.y - padR - 1.5));
          }

          const targetX = u.x + dx * desiredOffset;
          const targetY = u.y + dy * desiredOffset;
          if (this.canStandWithPadding(targetX, targetY, u.elevation, u.radius)) {
            applyPos(targetX, targetY, this.getWalkableElevation(targetX, targetY));
            return;
          }

          // 若目標點受牆壁或高地阻擋，僅盡可能貼近障礙物前緣
          let bestX = u.x;
          let bestY = u.y;
          const maxSteps = Math.max(1, Math.ceil(desiredOffset / 2));
          for (let s = 1; s <= maxSteps; s++) {
            const frac = s / maxSteps;
            const cx = u.x + dx * desiredOffset * frac;
            const cy = u.y + dy * desiredOffset * frac;
            let hitsTerrainCliff = !pointInRect(cx, cy, blk) && Math.abs(this.getWalkableElevation(cx, cy) - u.elevation) > 0.5;
            if (!hitsTerrainCliff) {
              for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2;
                const sx = cx + Math.cos(a) * padR;
                const sy = cy + Math.sin(a) * padR;
                if (!pointInRect(sx, sy, blk) && Math.abs(this.getWalkableElevation(sx, sy) - u.elevation) > 0.5) {
                  hitsTerrainCliff = true;
                  break;
                }
              }
            }
            // 僅檢查非本冰塊之地形／實牆阻擋，模擬抵牆位置
            const hitOtherWall =
              cx < padR ||
              cx > this.map.width - padR ||
              cy < padR ||
              cy > this.map.height - padR ||
              !this.isGroundWalkable(cx, cy) ||
              hitsTerrainCliff ||
              this.map.obstacles.some((obs) => (obs.kind === 'wall' || obs.style === 'railing') && resolveCircleRect(cx, cy, padR, obs).hit) ||
              this.map.trees.some((t) => resolveCircleRect(cx, cy, padR, t).hit) ||
              (this.map.pushableIceBlocks || []).some((ob) => ob.id !== blk.id && resolveCircleRect(cx, cy, padR, ob).hit);
            if (hitOtherWall) break;
            bestX = cx;
            bestY = cy;
          }
          applyPos(bestX, bestY, u.elevation);

          const crushRadius = blk.slideTimer === 0 ? Math.max(4, padR - 2) : Math.max(4, padR - 6);
          if (resolveCircleRect(bestX, bestY, crushRadius, blk).hit) {
            this.crushUnitByIceBlock(crushTarget, blk.pusherId, blk.pusherFaction);
          }
        };

        if (this.status === 'PLAYING' && this.player.hp > 0) {
          const p = this.player;
          shoveUnit(
            p,
            (nx, ny, ne) => {
              p.x = nx;
              p.y = ny;
              p.elevation = ne;
            },
            { isPlayer: true }
          );
        }

        for (const e of [...this.enemies]) {
          if (e.hp <= 0) continue;
          shoveUnit(
            e,
            (nx, ny, ne) => {
              e.x = nx;
              e.y = ny;
              e.elevation = ne;
            },
            { isPlayer: false, enemy: e }
          );
        }

        if (blk.slideTimer === 0) {
          blk.x = blk.slideEndX;
          blk.y = blk.slideEndY;
          blk.slideDir = null;
          blk.pusherId = null;
          blk.pusherFaction = null;
          navDirty = true;
        }
        continue;
      }

      // 靜止狀態：偵測貼齊冰塊某一側持續推動之角色
      let detectedDir: CardinalDir | null = null;
      let detectedPusher: { id: string; faction: FactionId } | null = null;

      for (const u of this.framePushInputs) {
        if (Math.abs(u.elevation - blk.baseElev) > 0.5) continue;
        const contactPad = u.radius + 10;
        let candDir: CardinalDir | null = null;

        if (
          u.dirX > 0.35 &&
          Math.abs(u.dirX) >= Math.abs(u.dirY) * 0.7 &&
          u.x < blk.x &&
          blk.x - u.x <= contactPad &&
          u.y >= blk.y + 4 &&
          u.y <= blk.y + blk.h - 4
        ) {
          candDir = 'east';
        } else if (
          u.dirX < -0.35 &&
          Math.abs(u.dirX) >= Math.abs(u.dirY) * 0.7 &&
          u.x > blk.x + blk.w &&
          u.x - (blk.x + blk.w) <= contactPad &&
          u.y >= blk.y + 4 &&
          u.y <= blk.y + blk.h - 4
        ) {
          candDir = 'west';
        } else if (
          u.dirY > 0.35 &&
          Math.abs(u.dirY) >= Math.abs(u.dirX) * 0.7 &&
          u.y < blk.y &&
          blk.y - u.y <= contactPad &&
          u.x >= blk.x + 4 &&
          u.x <= blk.x + blk.w - 4
        ) {
          candDir = 'south';
        } else if (
          u.dirY < -0.35 &&
          Math.abs(u.dirY) >= Math.abs(u.dirX) * 0.7 &&
          u.y > blk.y + blk.h &&
          u.y - (blk.y + blk.h) <= contactPad &&
          u.x >= blk.x + 4 &&
          u.x <= blk.x + blk.w - 4
        ) {
          candDir = 'north';
        }

        if (candDir && this.canSlidePushableIceBlock(blk, candDir)) {
          detectedDir = candDir;
          detectedPusher = { id: u.id, faction: u.faction };
          break;
        }
      }

      if (detectedDir && detectedPusher) {
        if (blk.pushDir === detectedDir) {
          blk.pushTimer += dt;
        } else {
          blk.pushDir = detectedDir;
          blk.pushTimer = dt;
        }
        blk.pusherId = detectedPusher.id;
        blk.pusherFaction = detectedPusher.faction;

        if (blk.pushTimer >= PUSH_HOLD_THRESHOLD) {
          const [dx, dy] = dirDelta[detectedDir];
          blk.pushTimer = 0;
          blk.pushDir = null;
          blk.slideDir = detectedDir;
          blk.slideDuration = 0.16;
          blk.slideTimer = 0.16;
          blk.slideStartX = blk.x;
          blk.slideStartY = blk.y;
          blk.slideEndX = blk.x + dx * TILE;
          blk.slideEndY = blk.y + dy * TILE;
          this.spawnBurst(blk.x + blk.w * 0.5, blk.y + blk.h * 0.5, '#BAE6FD', 8);
        }
      } else {
        blk.pushTimer = Math.max(0, blk.pushTimer - dt * 3);
        if (blk.pushTimer === 0) blk.pushDir = null;
      }
    }

    if (navDirty) {
      this.buildNavigationGraph();
    }
  }

  /**
   * 電腦士兵直線槍線射擊（套用與玩家相同之動態準心擴散、距離曲線與牆縫阻擋）
   */
  private getHitscanContact(
    seg: { x1: number; y1: number; x2: number; y2: number },
    target: PlayerState | EnemyEntity
  ) {
    if (target.royalShieldTimer <= 0) {
      return segmentCircleHit(seg.x1, seg.y1, seg.x2, seg.y2, target.x, target.y, target.radius);
    }

    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const startX = seg.x1 - target.x;
    const startY = seg.y1 - target.y;
    const radius = target.radius + ROYAL_SHIELD_PADDING;
    const lengthSquared = dx * dx + dy * dy;
    const startOffset = startX * startX + startY * startY - radius * radius;
    const projection = startX * dx + startY * dy;
    const discriminant = projection * projection - lengthSquared * startOffset;
    const t = startOffset <= 0
      ? 0
      : lengthSquared > 0 && discriminant >= 0
        ? (-projection - Math.sqrt(discriminant)) / lengthSquared
        : -1;
    return { hit: t >= 0 && t <= 1, t, hitX: seg.x1 + dx * t, hitY: seg.y1 + dy * t, perpDist: 0 };
  }

  private markShieldImpact(target: PlayerState | EnemyEntity, originX?: number, originY?: number) {
    const angle = originX === undefined || originY === undefined
      ? target.angle
      : Math.atan2(originY - target.y, originX - target.x);
    target.royalShieldImpact = { angle, time: this.time };
    return angle;
  }

  private deflectShieldShot(target: PlayerState | EnemyEntity, x: number, y: number, incoming: number) {
    const normal = this.markShieldImpact(target, x, y);
    const outgoing = 2 * normal - incoming + Math.PI;
    this.pushBeam({
      x1: x,
      y1: y,
      x2: x + Math.cos(outgoing) * 34,
      y2: y + Math.sin(outgoing) * 34,
      color: '#BAF2FF',
      life: 0.15,
      maxLife: 0.15,
      width: 2.4,
    });
    this.spawnBurst(x, y, '#BAF2FF', 3);
  }

  private fireEnemyGunHitscan(
    e: EnemyEntity,
    aimAngle: number,
    gunWeapon: Extract<EquippedWeapon, { type: 'gun' }>,
    targetDist = 200
  ) {
    const gunDef = gunWeapon.def;
    e.gunfireTimer = GUNFIRE_ANIMATION_SECONDS;
    sfx.gunshot(gunDef.kind, this.nearbySoundVolume(e.x, e.y) * 0.45);
    this.emitNetSfx('gun', e.x, e.y, gunDef.kind);
    if (e.royalShieldTimer > 0) {
      e.royalShieldTimer = 0; // 自己用遠程攻擊也會破盾！
      this.spawnText(e.x, e.y - 26, '遠程開火破盾', '#38BDF8', 0.9);
    }

    const muzzleDist = e.radius + 4;
    const pellets = gunDef.kind === 'shotgun' ? gunDef.pellets : 1;
    const difficultySpreadMult =
      AI_DIFFICULTY[this.difficulty].aimSpreadMultiplier / AI_DIFFICULTY.standard.aimSpreadMultiplier;
    const focus = e.isHumanPlayer
      ? (e.eagleEyeTimer > 0 ? RIFLE_RECOIL.eagleEyeMultiplier : 1)
      : (e.eagleEyeTimer > 0 ? 0.45 : 1) * AI_GUN_AIM.spreadMult * difficultySpreadMult;
    const clampedBloom = clamp(e.crosshairBloom, 0, gunDef.maxCrosshair - gunDef.baseCrosshair);
    const spreadRad = getGunSpread(gunDef.kind, gunDef.baseCrosshair + clampedBloom, targetDist, focus);
    const maxRange = Math.hypot(this.map.width, this.map.height) + TILE * 2;
    const p = this.player;

    for (let i = 0; i < pellets; i++) {
      const a = aimAngle + (Math.random() - 0.5) * spreadRad;
      const muzzleX = e.x + Math.cos(a) * muzzleDist;
      const muzzleY = e.y + Math.sin(a) * muzzleDist;
      const fullSeg = this.traceBulletSegment(e.x, e.y, a, maxRange, e.elevation, false);
      const fullSegDist = dist(e.x, e.y, fullSeg.x2, fullSeg.y2);
      const reachedMuzzle = fullSegDist >= muzzleDist - 0.5;

      let segEndX = fullSeg.x2;
      let segEndY = fullSeg.y2;

      type Candidate =
        | { kind: 'player'; t: number; perpDist: number; hitX: number; hitY: number }
        | { kind: 'enemy'; enemy: EnemyEntity; t: number; perpDist: number; hitX: number; hitY: number }
        | { kind: 'structure'; structure: SiegeStructure; t: number; perpDist: number; hitX: number; hitY: number };

      const candidates: Candidate[] = [];
      const allowFriendlyFire = Boolean(e.isHumanPlayer) && this.mode !== 'siege';

      if (
        p.hp > 0 &&
        (allowFriendlyFire || areHostile(e.faction, e.id, p.faction, 'player')) &&
        p.elevation - e.elevation < 2.0
      ) {
        const res = this.getHitscanContact(fullSeg, p);
        if (res.hit && !this.findEarliestWallHit(res.hitX, res.hitY, p.x, p.y)) {
          const hitDist = dist(fullSeg.x1, fullSeg.y1, res.hitX, res.hitY);
          if (p.elevation - fullSeg.elevAt(hitDist) < 2.0) {
            candidates.push({ kind: 'player', ...res });
          }
        }
      }

      for (const other of this.enemies) {
        if (other.id === e.id) continue;
        if (!allowFriendlyFire && !areHostile(e.faction, e.id, other.faction, other.id)) continue;
        if (other.elevation - e.elevation >= 2.0) continue;
        const res = this.getHitscanContact(fullSeg, other);
        if (res.hit && !this.findEarliestWallHit(res.hitX, res.hitY, other.x, other.y)) {
          const hitDist = dist(fullSeg.x1, fullSeg.y1, res.hitX, res.hitY);
          if (other.elevation - fullSeg.elevAt(hitDist) < 2.0) {
            candidates.push({ kind: 'enemy', enemy: other, ...res });
          }
        }
      }
      if (this.siege && (e.faction === 'royal' || e.faction === 'shadow')) {
        for (const st of this.siege.structures) {
          if (!st.alive || st.faction === e.faction) continue;
          const res = segmentCircleHit(fullSeg.x1, fullSeg.y1, fullSeg.x2, fullSeg.y2, st.x, st.y, st.radius);
          if (res.hit && !this.findEarliestWallHit(fullSeg.x1, fullSeg.y1, res.hitX, res.hitY)) {
            candidates.push({ kind: 'structure', structure: st, ...res });
          }
        }
      }

      candidates.sort((c1, c2) => c1.t - c2.t);
      if (candidates.length > 0) {
        const firstHit = candidates[0];
        const hitDist = dist(fullSeg.x1, fullSeg.y1, firstHit.hitX, firstHit.hitY);
        const gunProfile = this.siege ? getSiegeGunProfile(gunDef.kind) : null;
        segEndX = firstHit.hitX;
        segEndY = firstHit.hitY;

        if (firstHit.kind === 'structure') {
          const heroState = this.getSiegeHeroState(e.id);
          const fpMult = heroState ? 1 + (heroState.upgrades.firepower ?? 0) * 0.12 : 1;
          const rangeMult = heroState ? 1 + (heroState.upgrades.firepower ?? 0) * 0.08 : 1;
          const levelMult = this.siege && e.siegeUnitKind === 'hero'
            ? computeSiegeLevelAttackMult(heroState?.level ?? e.siegeLevel ?? 1)
            : 1;
          const falloffMult = this.siege ? computeSiegeGunFalloffMult(gunDef.kind, hitDist, rangeMult) : 1;
          const auraMult =
            e.siegeUnitKind === 'minion' || e.siegeUnitKind === 'super_minion'
              ? this.getSiegeMinionDamageMult(e)
              : 1;
          const profileMult = (gunProfile?.damageMult ?? 1) * (gunProfile?.structureBonusMult ?? 1);
          const stDmg = Math.max(2, Math.round(gunDef.damage * 0.72 * fpMult * levelMult * falloffMult * auraMult * profileMult));
          this.damageSiegeStructure(firstHit.structure, stDmg, e.id, e.faction);
        } else {
          const targetRadius = firstHit.kind === 'player' ? p.radius : firstHit.enemy.radius;
          const centerAccuracy = clamp(1 - firstHit.perpDist / targetRadius, 0, 1);
          const heroState = this.getSiegeHeroState(e.id);
          const fpMult = heroState ? 1 + (heroState.upgrades.firepower ?? 0) * 0.12 : 1;
          const rangeMult = heroState ? 1 + (heroState.upgrades.firepower ?? 0) * 0.08 : 1;
          const levelMult = this.siege && e.siegeUnitKind === 'hero'
            ? computeSiegeLevelAttackMult(heroState?.level ?? e.siegeLevel ?? 1)
            : 1;
          const falloffMult = this.siege ? computeSiegeGunFalloffMult(gunDef.kind, hitDist, rangeMult) : 1;
          const auraMult =
            e.siegeUnitKind === 'minion' || e.siegeUnitKind === 'super_minion'
              ? this.getSiegeMinionDamageMult(e)
              : 1;
          const profileMult = gunProfile?.damageMult ?? 1;
          const defPen = gunProfile?.defensePenetration ?? 0;
          const scaledDmg = Math.max(
            2,
            Math.round(gunDef.damage * (0.4 + 0.6 * centerAccuracy) * fpMult * levelMult * falloffMult * auraMult * profileMult)
          );

          const target = firstHit.kind === 'player' ? p : firstHit.enemy;
          if (target.royalShieldTimer > 0) {
            this.deflectShieldShot(target, firstHit.hitX, firstHit.hitY, a);
          } else if (firstHit.kind === 'player') {
            const isHostileToPlayer = areHostile(e.faction, e.id, p.faction, 'player');
            if (isHostileToPlayer) {
              this.damagePlayer(scaledDmg, false, e.id, e.x, e.y, false, defPen);
            } else {
              this.damagePlayer(Math.max(1, Math.round(scaledDmg * 0.5)), false, e.id, e.x, e.y, true, defPen);
            }
          } else {
            this.damageEnemy(
              firstHit.enemy,
              scaledDmg,
              false,
              Math.cos(a) * 80,
              Math.sin(a) * 80,
              centerAccuracy >= 0.8,
              false,
              e.id,
              e.faction,
              e.x,
              e.y,
              defPen
            );
          }
        }
      } else if (reachedMuzzle && fullSegDist < maxRange - 1) {
        this.spawnBurst(fullSeg.x2, fullSeg.y2, '#E2E8F0', 4);
      }

      const endDist = dist(e.x, e.y, segEndX, segEndY);
      const beamStartX = reachedMuzzle && endDist > muzzleDist ? muzzleX : e.x;
      const beamStartY = reachedMuzzle && endDist > muzzleDist ? muzzleY : e.y;

      this.pushBeam({
        x1: beamStartX,
        y1: beamStartY,
        x2: segEndX,
        y2: segEndY,
        color: e.color,
        life: gunDef.kind === 'sniper' ? 0.14 : 0.085,
        maxLife: gunDef.kind === 'sniper' ? 0.14 : 0.085,
        width: gunDef.kind === 'sniper' ? 2.6 : 1.9,
      });
    }

    e.crosshairBloom = Math.min(gunDef.maxCrosshair - gunDef.baseCrosshair, clampedBloom + gunDef.bloomPerShot);
    if (gunDef.kind === 'sniper') {
      e.bloomDelayTimer = Math.max(e.bloomDelayTimer, SNIPER_AIM.settleDelaySeconds);
    }
  }

  /**
   * 電腦士兵施放陣營 × 近戰武器技能（持續時間、傷害與集氣規則與玩家對齊）
   */
  private executeEnemyFactionSkill(
    e: EnemyEntity,
    meleeWeapon: Extract<EquippedWeapon, { type: 'melee' }>,
    aimAngle: number
  ) {
    if (this.siege && e.siegeLoadout && meleeWeapon.def.kind !== 'shield') {
      const ultId = e.siegeLoadout.ultimateId;
      const ultMeta = getUltimateMeta(ultId);
      this.spawnText(e.x, e.y - 34, ultMeta.name, e.color, 1.05);
      this.castSiegeUltimateSkill(e.id, e, ultId, aimAngle, 1.0);
      return;
    }
    const fac = e.faction;
    const mk = meleeWeapon.def.kind;
    const skillName = FACTIONS[fac].meleeSkills[mk].name;
    this.spawnText(e.x, e.y - 34, skillName, e.color, 1.05);

    if (mk === 'shield') {
      meleeWeapon.durability = 100;
      this.spawnBurst(e.x, e.y, '#38BDF8', 16);
      this.pushSlash({
        x: e.x,
        y: e.y,
        angle: aimAngle,
        arc: Math.PI * 1.4,
        reach: 120,
        color: '#38BDF8',
        life: 0.26,
        maxLife: 0.26,
        isUltimate: true,
        style: 'sweep',
      });
      const p = this.player;
      if (p.hp > 0 && areHostile(e.faction, e.id, p.faction, 'player') && Math.abs(e.elevation - p.elevation) <= 1.0 && dist(e.x, e.y, p.x, p.y) <= 125 + p.radius) {
        const ang = Math.atan2(p.y - e.y, p.x - e.x);
        const pushed = this.moveCharacterWithElevation(p.x, p.y, p.elevation, Math.cos(ang) * 44, Math.sin(ang) * 44, p.radius);
        p.x = pushed.x;
        p.y = pushed.y;
        p.elevation = pushed.elevation;
        this.damagePlayer(0, true, e.id, e.x, e.y);
      }
      for (const other of [...this.enemies]) {
        if (other.id === e.id) continue;
        if (!areHostile(e.faction, e.id, other.faction, other.id)) continue;
        if (Math.abs(e.elevation - other.elevation) > 1.0) continue;
        if (dist(e.x, e.y, other.x, other.y) <= 125 + other.radius) {
          const ang = Math.atan2(other.y - e.y, other.x - e.x);
          this.damageEnemy(other, 0, true, Math.cos(ang) * 1050, Math.sin(ang) * 1050, false, true, e.id, e.faction, e.x, e.y);
          other.stunTimer = Math.max(other.stunTimer, 0.45);
        }
      }
      return;
    }

    if (fac === 'royal') {
      if (mk === 'knife') {
        e.royalShieldTimer = 6.5;
        e.royalShieldImpact = undefined;
      } else if (mk === 'claw') {
        // 瞬移靠近敵人並閃光致盲（對敵對 AI 與敵對玩家皆會生效）
        const p = this.player;
        const targets: { x: number; y: number; r: number }[] = [];
        if (p.hp > 0 && areHostile(e.faction, e.id, p.faction, 'player')) {
          targets.push({ x: p.x, y: p.y, r: p.radius });
        }
        for (const other of this.enemies) {
          if (areHostile(e.faction, e.id, other.faction, other.id)) {
            targets.push({ x: other.x, y: other.y, r: other.radius });
          }
        }
        if (targets.length > 0) {
          targets.sort((a, b) => dist(e.x, e.y, a.x, a.y) - dist(e.x, e.y, b.x, b.y));
          const t = targets[0];
          const ang = Math.atan2(t.y - e.y, t.x - e.x);
          const safeSpot = this.findSafeTeleportSpot(
            t.x,
            t.y,
            ang,
            e.radius + t.r + 6,
            e.radius,
            e.x,
            e.y
          );
          this.addSkillTrace('blink', e, safeSpot, 0.58);
          e.x = safeSpot.x;
          e.y = safeSpot.y;
          e.elevation = this.getWalkableElevation(e.x, e.y);
        }
        this.pushSlash({
          x: e.x,
          y: e.y,
          angle: 0,
          arc: Math.PI * 2,
          reach: 220,
          color: '#FFFFFF',
          life: 0.25,
          maxLife: 0.25,
          isUltimate: true,
          style: 'sweep',
        });
        if (p.hp > 0 && areHostile(e.faction, e.id, p.faction, 'player')) {
          const dp = dist(e.x, e.y, p.x, p.y);
          if (dp <= 260) {
            const blindSec = clamp(1.0 - (dp / 260) * 0.5, 0.5, 1.0);
            p.blindDuration = blindSec;
            p.blindTimer = Math.max(p.blindTimer, blindSec);
            this.spawnText(p.x, p.y - 34, `致盲 ${blindSec.toFixed(1)}s`, '#FEF08A', 1.05);
          }
        }
        for (const other of this.enemies) {
          if (!areHostile(e.faction, e.id, other.faction, other.id)) continue;
          const d = dist(e.x, e.y, other.x, other.y);
          if (d <= 260) {
            const blindSec = clamp(1.0 - (d / 260) * 0.5, 0.5, 1.0);
            other.blindTimer = Math.max(other.blindTimer, blindSec);
          }
        }
      } else {
        // 皇家大刀 5 發黃色光彈（會傷友軍，數值與玩家一致）
        for (const off of [-0.34, -0.17, 0, 0.17, 0.34]) {
          const a = aimAngle + off;
          this.projectiles.push({
            id: uid('elorb'),
            x: e.x + Math.cos(a) * 26,
            y: e.y + Math.sin(a) * 26,
            prevX: e.x,
            prevY: e.y,
            vx: Math.cos(a) * 560,
            vy: Math.sin(a) * 560,
            radius: 13,
            damage: 30,
            startElevation: e.elevation,
            minTraversedElevation: e.elevation,
            ownerId: e.id,
            ownerFaction: e.faction,
            fromPlayer: false,
            isAlly: e.isAlly,
            noFriendlyFire: false,
            color: '#FACC15',
            life: 1.25,
            maxLife: 1.25,
            pierce: 99,
            isLightOrb: true,
            hitIds: new Set(),
          });
        }
      }
      return;
    }

    if (fac === 'shadow') {
      if (mk === 'knife') {
        e.eagleEyeTimer = EAGLE_EYE_DURATION;
      } else if (mk === 'claw') {
        e.shadowCloneTimer = 6.5;
      } else {
        const dir = snapToEightDirections(aimAngle);
        const startX = e.x + dir.dx * 28;
        const startY = e.y + dir.dy * 28;
        this.projectiles.push({
          id: uid('edragon'),
          x: startX,
          y: startY,
          prevX: e.x,
          prevY: e.y,
          vx: dir.dx * 340,
          vy: dir.dy * 340,
          radius: 22,
          damage: 20,
          headDamage: 20,
          bodyDamage: 15,
          startElevation: e.elevation,
          minTraversedElevation: e.elevation,
          ownerId: e.id,
          ownerFaction: e.faction,
          fromPlayer: false,
          isAlly: e.isAlly,
          noFriendlyFire: true,
          color: '#312E81',
          life: 3.5,
          maxLife: 3.5,
          pierce: 99,
          isWave: true,
          isBlackDragon: true,
          segments: [{ x: startX, y: startY }],
          bouncesLeft: 5,
          distanceTraveled: 0,
          maxDistance: 1050,
          targetHitCooldowns: {},
          hitIds: new Set(),
        });
      }
      return;
    }

    if (mk === 'knife') {
      e.vampireTimer = 7.5;
    } else if (mk === 'claw') {
      e.giantTimer = 0;
      e.shrinkTimer = 7.5;
    } else {
      e.shrinkTimer = 0;
      e.giantTimer = 7.5;
    }
  }

  private choosePatrolTarget(enemy: EnemyEntity): { x: number; y: number } | null {
    const start = this.findNearestStandableTile(Math.floor(enemy.x / TILE), Math.floor(enemy.y / TILE));
    if (start === null) return null;
    const { cols } = this.map;
    const queue = [{ tile: start, steps: 0 }];
    const visited = new Set([start]);
    const candidates: { x: number; y: number }[] = [];
    for (let i = 0; i < queue.length; i++) {
      const { tile, steps } = queue[i];
      const x = (tile % cols + 0.5) * TILE;
      const y = (Math.floor(tile / cols) + 0.5) * TILE;
      if (
        steps > 0 && dist(enemy.x, enemy.y, x, y) >= TILE * 0.75 &&
        dist(enemy.patrolAnchor.x, enemy.patrolAnchor.y, x, y) <= AI_PATROL.radius
      ) {
        candidates.push({ x, y });
      }
      if (steps === AI_PATROL.searchSteps) continue;
      for (const next of this.navAdj.get(tile) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push({ tile: next, steps: steps + 1 });
      }
    }
    return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
  }

  private getPatrolGoal(enemy: EnemyEntity, dt: number) {
    enemy.patrolTimer -= dt;
    const arrived = enemy.patrolTarget &&
      dist(enemy.x, enemy.y, enemy.patrolTarget.x, enemy.patrolTarget.y) < AI_PATROL.arrivalDistance;
    if (enemy.patrolTimer <= 0 || arrived) {
      if (dist(enemy.x, enemy.y, enemy.patrolAnchor.x, enemy.patrolAnchor.y) > AI_PATROL.radius) {
        enemy.patrolAnchor = { x: enemy.x, y: enemy.y };
      }
      enemy.patrolTarget = this.choosePatrolTarget(enemy);
      enemy.patrolTimer = enemy.patrolTarget ? AI_PATROL.legSeconds : AI_PATROL.retrySeconds;
      enemy.pathTimer = 0;
    }
    return enemy.patrolTarget;
  }

  private updateEnemies(dt: number) {
    const p = this.player;
    const aiRepMult = getReputationQiMultiplier(AI_FIXED_REPUTATION);
    const difficulty = AI_DIFFICULTY[this.difficulty];
    for (const e of [...this.enemies]) {
      if (!this.isBattleActive()) return;
      if (e.hp <= 0) continue;
      if (e.isHumanPlayer) {
        this.updateRemoteHuman(e, dt);
        continue;
      }
      const combat = AI_COMBAT[e.archetype];
      e.gunfireTimer = Math.max(0, e.gunfireTimer - dt);
      const aiHeldWeapon = e.weapons[e.activeHand];
      const aiHoldingSniper = aiHeldWeapon.type === 'gun' && aiHeldWeapon.def.kind === 'sniper';
      if (aiHoldingSniper && e.bloomDelayTimer > 0) {
        e.bloomDelayTimer = Math.max(0, e.bloomDelayTimer - dt);
      } else {
        const recoveryRate = aiHoldingSniper ? SNIPER_AIM.bloomRecovery : GUN_AIM.bloomRecovery;
        e.crosshairBloom = Math.max(0, e.crosshairBloom - recoveryRate * dt);
      }
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.invulnTimer = Math.max(0, (e.invulnTimer ?? 0) - dt);
      e.swapTimer = Math.max(0, e.swapTimer - dt);
      e.attackAnimTimer = Math.max(0, e.attackAnimTimer - dt);
      if (e.attackAnimTimer === 0) e.attackAnimKind = null;
      e.attackCooldown = Math.max(0, e.attackCooldown - dt);
      e.freezeTimer = Math.max(0, e.freezeTimer - dt);
      e.royalShieldTimer = Math.max(0, e.royalShieldTimer - dt);
      e.eagleEyeTimer = Math.max(0, e.eagleEyeTimer - dt);
      e.shadowCloneTimer = Math.max(0, e.shadowCloneTimer - dt);
      e.vampireTimer = Math.max(0, e.vampireTimer - dt);
      e.shrinkTimer = Math.max(0, e.shrinkTimer - dt);
      e.giantTimer = Math.max(0, e.giantTimer - dt);
      e.aiTimer += dt;
      e.alertTimer = Math.max(0, e.alertTimer - dt);
      e.aggroLockTimer = Math.max(0, e.aggroLockTimer - dt);
      e.pathTimer = Math.max(0, e.pathTimer - dt);
      if (this.siege) {
        if ((e.siegeTacticalCd ?? 0) > 0) e.siegeTacticalCd = Math.max(0, (e.siegeTacticalCd ?? 0) - dt);
        if ((e.siegeMarkedTimer ?? 0) > 0) e.siegeMarkedTimer = Math.max(0, (e.siegeMarkedTimer ?? 0) - dt);
        if ((e.siegeAegisReflectTimer ?? 0) > 0) e.siegeAegisReflectTimer = Math.max(0, (e.siegeAegisReflectTimer ?? 0) - dt);
      }

      if (e.freezeTimer > 0) {
        this.clearTimedSkillsOnFreeze(e);
      }

      // 電腦與玩家共用彈匣裝填計時（僅在當前持握槍械手位上進行，惟電腦備用彈藥無限）
      const activeReloadWeapon = e.weapons[e.activeHand];
      if (activeReloadWeapon.type === 'gun' && activeReloadWeapon.reloadTimer > 0) {
        activeReloadWeapon.reloadTimer = Math.max(0, activeReloadWeapon.reloadTimer - dt);
        if (activeReloadWeapon.reloadTimer === 0) {
          activeReloadWeapon.ammoInMag = activeReloadWeapon.def.magSize;
        }
      }

      e.sizeScale = e.shrinkTimer > 0 ? 0.62 : e.giantTimer > 0 ? 1.32 : 1.0;
      e.radius = e.baseRadius * e.sizeScale;

      if (e.stunTimer > 0) {
        this.applyIceVentFreezeCheck(e, false);
        e.stunTimer = Math.max(0, e.stunTimer - dt);
        e.visibleTargetId = null;
        e.chargingMelee = false;
        e.chargeReady = false;
        if (e.freezeTimer <= 0) {
          e.qi = Math.min(e.maxQi, e.qi + QI_RATE.recover * aiRepMult * dt);
        }
        e.lastAimAngle = e.angle;
        continue;
      }

      if (e.blindTimer > 0) {
        this.applyIceVentFreezeCheck(e, false);
        e.blindTimer = Math.max(0, e.blindTimer - dt);
        e.angle += dt * 7;
        e.lastAimAngle = e.angle;
        e.hasLosToTarget = false;
        e.visibleTargetId = null;
        e.chargingMelee = false;
        e.chargeReady = false;
        if (e.freezeTimer <= 0) {
          e.qi = Math.min(e.maxQi, e.qi + QI_RATE.recover * aiRepMult * dt);
        }
        continue;
      }

      const heldGun = this.getEnemyGun(e);
      const heldMelee = this.getEnemyMelee(e);

      // 敵人基礎視野半徑調整為 8 格（鷹眼／狙擊手半徑 9.5 格）
      const sightRange = (e.eagleEyeTimer > 0 || heldGun?.def.kind === 'sniper' ? 9.5 : 8.0) * TILE;

      // 確認當前追擊對象是否仍存活且敵對
      if (e.focusedTargetId) {
        if (e.focusedTargetId === 'player') {
          if (p.hp <= 0 || !areHostile(e.faction, e.id, p.faction, 'player')) {
            e.focusedTargetId = null;
            e.lastSeenTargetPos = null;
            e.alertTimer = 0;
            e.pathTiles = [];
          }
        } else {
          const ft = this.enemies.find((oe) => oe.id === e.focusedTargetId);
          if (!ft || !areHostile(e.faction, e.id, ft.faction, ft.id)) {
            e.focusedTargetId = null;
            e.pathTiles = [];
          }
        }
      }

      type VisibleCandidate = {
        id: string;
        isPlayer: boolean;
        entity: EnemyEntity | null;
        x: number;
        y: number;
        elev: number;
        d: number;
      };
      const visibleHostiles: VisibleCandidate[] = [];

      if (p.hp > 0 && areHostile(e.faction, e.id, p.faction, 'player')) {
        if (this.hasLineOfSight(e.x, e.y, e.elevation, p.x, p.y, p.elevation, sightRange)) {
          visibleHostiles.push({
            id: 'player',
            isPlayer: true,
            entity: null,
            x: p.x,
            y: p.y,
            elev: p.elevation,
            d: dist(e.x, e.y, p.x, p.y),
          });
        }
      }

      for (const other of this.enemies) {
        if (!areHostile(e.faction, e.id, other.faction, other.id)) continue;
        if (this.siege && (other.siegeUnitKind === 'jungle' || other.siegeUnitKind === 'boss')) {
          if (e.siegeUnitKind === 'minion' || e.siegeUnitKind === 'super_minion' || e.siegeUnitKind === 'vanguard_ally') {
            continue;
          }
          if (e.siegeUnitKind === 'hero' && other.focusedTargetId !== e.id) {
            continue;
          }
        }
        if (this.hasLineOfSight(e.x, e.y, e.elevation, other.x, other.y, other.elevation, sightRange)) {
          visibleHostiles.push({
            id: other.id,
            isPlayer: false,
            entity: other,
            x: other.x,
            y: other.y,
            elev: other.elevation,
            d: dist(e.x, e.y, other.x, other.y),
          });
        }
      }

      visibleHostiles.sort((a, b) => a.d - b.d);

      let chosenVisible: VisibleCandidate | null = null;
      if (visibleHostiles.length > 0) {
        const focusedVis = e.focusedTargetId
          ? visibleHostiles.find((v) => v.id === e.focusedTargetId) || null
          : null;
        if (focusedVis && (e.aggroLockTimer > 0 || visibleHostiles[0].d >= focusedVis.d * 0.65)) {
          chosenVisible = focusedVis;
        } else {
          chosenVisible = visibleHostiles[0];
          e.focusedTargetId = chosenVisible.id;
          e.aggroLockTimer = 3.0;
        }
      }

      const bestLosDist = chosenVisible ? chosenVisible.d : Infinity;
      const losTargetPos = chosenVisible
        ? { x: chosenVisible.x, y: chosenVisible.y, elev: chosenVisible.elev }
        : null;
      const targetIsPlayer = Boolean(chosenVisible?.isPlayer);
      const targetEntity = chosenVisible?.entity || null;

      const prevHasLos = e.hasLosToTarget;
      e.hasLosToTarget = Boolean(losTargetPos);
      if (!prevHasLos && e.hasLosToTarget) {
        this.spawnText(e.x, e.y - e.radius - 24, '!', '#FACC15', 1.25);
      }
      const visibleTargetId = chosenVisible?.id ?? null;
      if (e.visibleTargetId !== visibleTargetId) {
        e.visibleTargetId = visibleTargetId;
        e.reactionTimer = visibleTargetId
          ? Math.max(e.reactionTimer, combat.reactionSeconds * difficulty.reactionMultiplier)
          : Math.max(0, e.reactionTimer - dt);
        e.chargingMelee = false;
        e.chargeReady = false;
      } else {
        e.reactionTimer = Math.max(0, e.reactionTimer - dt);
      }
      const readyToAttack = Boolean(visibleTargetId) && e.reactionTimer === 0;

      if (losTargetPos) {
        e.lastSeenTargetPos = { x: losTargetPos.x, y: losTargetPos.y };
        e.alertTimer = 6.5;
      }

      const canHitRanged = losTargetPos
        ? this.canRangedHitTarget(e.x, e.y, e.elevation, losTargetPos.x, losTargetPos.y, losTargetPos.elev)
        : false;
      const meleeEngageRange = Math.max(84, (heldMelee?.def.reach ?? 56) + 22);
      const isCloseMeleeRange = Boolean(
        losTargetPos && bestLosDist <= meleeEngageRange && Math.abs(e.elevation - losTargetPos.elev) <= 1.0
      );

      // 雙手武器切換邏輯（完全沿用 swapTimer 搓手切換時間）：
      // - 純近戰單位（無槍械）恆常持握近戰兵器
      // - 持盾敵人於裝彈或中近距受傷推進時，主動切出盾牌進行正面防禦
      // - 貼身近戰距離（或已切近戰追擊中且距離 <= 125px、或槍械裝彈時距離 <= 135px）且高度可及 -> 持近戰主動搶攻
      // - 有一定距離且槍彈可射中目標 -> 切遠程槍械手位
      // - 其餘狀態／高低差受阻／趕路追擊 -> 切換最輕武器手位加速移動
      const gunHand = this.getEnemyHandByType(e, 'gun');
      const meleeHand = this.getEnemyHandByType(e, 'melee');
      const shieldHand: WeaponHand | -1 =
        e.weapons[0].type === 'melee' && e.weapons[0].def.kind === 'shield' && e.weapons[0].durability > 0
          ? 0
          : e.weapons[1].type === 'melee' && e.weapons[1].def.kind === 'shield' && e.weapons[1].durability > 0
            ? 1
            : -1;
      const curActiveWeapon = e.weapons[e.activeHand];
      const activeGunReloading = curActiveWeapon.type === 'gun' && curActiveWeapon.reloadTimer > 0;
      const sameElevForMelee = Boolean(losTargetPos && Math.abs(e.elevation - losTargetPos.elev) <= 1.0);
      const stickyMeleeChase =
        meleeHand !== -1 &&
        curActiveWeapon.type === 'melee' &&
        curActiveWeapon.def.kind !== 'shield' &&
        sameElevForMelee &&
        bestLosDist <= 125;
      const meleePunishOnReload =
        meleeHand !== -1 &&
        heldMelee?.def.kind !== 'shield' &&
        activeGunReloading &&
        sameElevForMelee &&
        bestLosDist <= 135;

      let desiredHand: WeaponHand;
      if (gunHand === -1 && meleeHand !== -1) {
        desiredHand = meleeHand;
      } else if (shieldHand !== -1 && Boolean(losTargetPos) && bestLosDist <= 155 && e.hp < 55) {
        desiredHand = shieldHand;
      } else if ((isCloseMeleeRange || stickyMeleeChase || meleePunishOnReload) && meleeHand !== -1) {
        desiredHand = meleeHand;
      } else if (losTargetPos && canHitRanged && gunHand !== -1) {
        desiredHand = gunHand;
      } else if (activeGunReloading) {
        desiredHand = e.activeHand;
      } else {
        desiredHand = this.getLightestEnemyHand(e);
      }
      this.switchEnemyHand(e, desiredHand);

      // 與玩家對齊之氣條集氣／回氣規則（電腦固定以 100 聲望之 1.5x 倍率運作，冰凍期間不能集氣）
      const activeWeapon = e.weapons[e.activeHand];
      if (e.freezeTimer > 0) {
        e.chargingMelee = false;
        e.chargeReady = false;
      } else if (activeWeapon.type !== 'melee') {
        e.chargingMelee = false;
        e.chargeReady = false;
        e.qi = Math.min(e.maxQi, e.qi + QI_RATE.recover * aiRepMult * dt);
      } else if (e.chargingMelee) {
        e.qi = Math.max(0, e.qi - QI_RATE.charge * aiRepMult * dt);
        if (e.qi === 0 && e.swapTimer <= 0) {
          e.chargeReady = true;
          this.spawnBurst(e.x, e.y, '#FDE047', 14);
          const castAng = losTargetPos
            ? Math.atan2(losTargetPos.y - e.y, losTargetPos.x - e.x)
            : e.angle;
          this.executeEnemyFactionSkill(e, activeWeapon, castAng);
          e.chargingMelee = false;
          e.chargeReady = false;
          e.attackCooldown = Math.max(e.attackCooldown, 0.25);
        }
      } else {
        e.qi = Math.min(e.maxQi, e.qi + QI_RATE.recover * aiRepMult * dt);
        const siegeUltUnlocked =
          this.mode !== 'siege' ||
          activeWeapon.def.kind === 'shield' ||
          (e.siegeLevel ?? 1) >= SIEGE_CONFIG.ultimateUnlockLevel;
        const needEmergencyShieldRepair =
          !losTargetPos && activeWeapon.def.kind === 'shield' && activeWeapon.durability <= 45;
        if (siegeUltUnlocked && e.swapTimer <= 0 && e.qi >= e.maxQi - 0.5 && (readyToAttack || needEmergencyShieldRepair)) {
          e.chargingMelee = true;
          e.chargeReady = false;
        }
      }

      let desiredX = e.x;
      let desiredY = e.y;
      let moveFactor = 0;
      let astarGoal: { x: number; y: number } | null = null;
      let patrolling = false;
      if (!losTargetPos && e.lastSeenTargetPos && dist(e.x, e.y, e.lastSeenTargetPos.x, e.lastSeenTargetPos.y) < 24) {
        e.patrolAnchor = { x: e.x, y: e.y };
        e.patrolTimer = 0;
        e.lastSeenTargetPos = null;
      }
      const desiredPickup = this.mode === 'siege' ? null : this.findNearestEligibleWeaponPickup(e);
      const siegeStructureTarget =
        this.siege &&
        (e.faction === 'royal' || e.faction === 'shadow') &&
        !losTargetPos
          ? this.findNearestHostileStructureInSight(e, sightRange + 40)
          : null;
      const siegeGoal = this.siege && !losTargetPos && !siegeStructureTarget ? this.getSiegeAiGoal(e) : null;

      if (
        this.siege &&
        e.siegeUnitKind === 'hero' &&
        e.siegeLoadout &&
        (e.siegeLevel ?? 1) >= SIEGE_CONFIG.tacticalUnlockLevel &&
        (e.siegeTacticalCd ?? 0) <= 0 &&
        losTargetPos &&
        readyToAttack
      ) {
        if (bestLosDist <= 300 && (e.hp < e.maxHp * 0.72 || bestLosDist <= 185)) {
          this.castSiegeTacticalSkill(e.id, e, e.siegeLoadout, losTargetPos.x, losTargetPos.y);
          e.siegeTacticalCd = computeSiegeTacticalCooldown({
            loadout: e.siegeLoadout,
            upgrades: e.siegeUpgrades ?? { firepower: 0, blade: 0, armor: 0, core: 0 },
          });
        }
      }

      if (losTargetPos) {
        const rawTargetAngle = Math.atan2(losTargetPos.y - e.y, losTargetPos.x - e.x);
        // 模擬玩家手持滑鼠手部微幅追蹤偏擺與有限轉向角速度
        const idSeed = (e.id.charCodeAt(e.id.length - 1) || 1) * 1.37;
        const wobble =
          Math.sin(e.aiTimer * 2.9 + idSeed) * (AI_GUN_AIM.aimWobbleRad * 0.65) +
          Math.cos(e.aiTimer * 5.3 + idSeed * 1.7) * (AI_GUN_AIM.aimWobbleRad * 0.35);
        const desiredAimAngle = rawTargetAngle + wobble;
        const maxTurn = combat.aimTurnSpeed * dt;
        e.angle += clamp(angleDiff(e.angle, desiredAimAngle), -maxTurn, maxTurn);
        const aimAngle = rawTargetAngle;

        const isMeleeFighting = !heldGun || activeWeapon.type === 'melee';
        const activeMeleeReach =
          activeWeapon.type === 'melee' ? activeWeapon.def.reach : (heldMelee?.def.reach ?? 56);
        const meleeStrikeRange = clamp(activeMeleeReach * 0.72, 30, 52);

        const desiredRange = isMeleeFighting
          ? meleeStrikeRange
          : !canHitRanged
            ? 44
            : heldMelee?.def.kind === 'claw' || heldMelee?.def.kind === 'greatsword'
              ? 135
              : heldGun?.def.kind === 'sniper'
                ? AI_COMBAT.sniper.preferredRange
                : combat.preferredRange;

        const needsClimb = losTargetPos.elev > e.elevation + 0.5;
        const holdingHighGround = !isMeleeFighting && e.elevation > losTargetPos.elev + 0.25 && canHitRanged;
        const enemyCanHitAi = this.canRangedHitTarget(
          losTargetPos.x,
          losTargetPos.y,
          losTargetPos.elev,
          e.x,
          e.y,
          e.elevation
        );
        const aiHasOneWayAdvantage = !isMeleeFighting && canHitRanged && !enemyCanHitAi;
        const tacticalSpot =
          !isMeleeFighting && heldGun && (canHitRanged || !needsClimb)
            ? this.findBestTacticalSpot(
                e,
                losTargetPos,
                sightRange,
                desiredRange,
                holdingHighGround,
                activeGunReloading
              )
            : null;

        if (isMeleeFighting) {
          // 近戰單位或正持近戰搏鬥的 AI：絕不拉開後退，果斷貼近目標並保持壓迫斬擊
          if (bestLosDist > meleeStrikeRange || needsClimb || Math.abs(e.elevation - losTargetPos.elev) > 0.5) {
            astarGoal = { x: losTargetPos.x, y: losTargetPos.y };
            desiredX = losTargetPos.x;
            desiredY = losTargetPos.y;
            moveFactor = 1.05;
          } else if (bestLosDist > Math.max(24, e.radius * 1.45)) {
            desiredX = losTargetPos.x;
            desiredY = losTargetPos.y;
            moveFactor = 0.65;
          } else {
            const strafe = aimAngle + (Math.sin(e.aiTimer * 3.1 + idSeed) > 0 ? Math.PI / 2 : -Math.PI / 2);
            desiredX = e.x + Math.cos(strafe) * 40 + Math.cos(aimAngle) * 18;
            desiredY = e.y + Math.sin(strafe) * 40 + Math.sin(aimAngle) * 18;
            moveFactor = 0.35;
          }
        } else if (!canHitRanged || needsClimb) {
          if (tacticalSpot && tacticalSpot.oneWayAdvantage) {
            astarGoal = { x: tacticalSpot.x, y: tacticalSpot.y };
            desiredX = tacticalSpot.x;
            desiredY = tacticalSpot.y;
            moveFactor = 1.0;
          } else {
            astarGoal = { x: losTargetPos.x, y: losTargetPos.y };
            desiredX = losTargetPos.x;
            desiredY = losTargetPos.y;
            moveFactor = 1.0;
          }
        } else if (holdingHighGround) {
          // 佔據高地且可射擊低處目標時，嚴守高地優勢絕不下坡送頭；優先微調至單向掩體高點
          if (tacticalSpot && !tacticalSpot.isCurrentTile && tacticalSpot.scoreGain > 16) {
            desiredX = tacticalSpot.x;
            desiredY = tacticalSpot.y;
            moveFactor = 0.72;
          } else if (bestLosDist > desiredRange + 90) {
            // 只在高地邊緣視距拉太開時貼近邊緣但仍不降層
            if (tacticalSpot && !tacticalSpot.isCurrentTile) {
              desiredX = tacticalSpot.x;
              desiredY = tacticalSpot.y;
              moveFactor = 0.65;
            } else {
              moveFactor = 0;
            }
          } else {
            moveFactor = 0;
          }
        } else if (aiHasOneWayAdvantage && !activeGunReloading && bestLosDist <= desiredRange + 65) {
          // 已經取得「我打得到敵人、敵人打不到我」的單向優勢掩體站位，穩住架槍
          moveFactor = 0;
        } else if (tacticalSpot && !tacticalSpot.isCurrentTile && tacticalSpot.scoreGain > 22) {
          desiredX = tacticalSpot.x;
          desiredY = tacticalSpot.y;
          moveFactor = 0.85;
        } else if (bestLosDist > desiredRange + 24) {
          astarGoal = { x: losTargetPos.x, y: losTargetPos.y };
          desiredX = losTargetPos.x;
          desiredY = losTargetPos.y;
          moveFactor = 1.0;
        } else if (bestLosDist < desiredRange - 55) {
          desiredX = e.x - Math.cos(aimAngle) * 120;
          desiredY = e.y - Math.sin(aimAngle) * 120;
          moveFactor = 0.65;
        } else {
          const strafe = aimAngle + (Math.sin(e.aiTimer * 2.1) > 0 ? Math.PI / 2 : -Math.PI / 2);
          desiredX = e.x + Math.cos(strafe) * 80;
          desiredY = e.y + Math.sin(strafe) * 80;
          moveFactor = 0.5;
        }
      } else if (siegeStructureTarget) {
        const stopDist = (heldGun ? Math.min(200, siegeStructureTarget.radius + 175) : siegeStructureTarget.radius + 52);
        const sd = dist(e.x, e.y, siegeStructureTarget.x, siegeStructureTarget.y);
        const maxTurn = combat.aimTurnSpeed * dt;
        e.angle += clamp(angleDiff(e.angle, Math.atan2(siegeStructureTarget.y - e.y, siegeStructureTarget.x - e.x)), -maxTurn, maxTurn);
        if (sd > stopDist) {
          astarGoal = { x: siegeStructureTarget.x, y: siegeStructureTarget.y };
          desiredX = siegeStructureTarget.x;
          desiredY = siegeStructureTarget.y;
          moveFactor = 0.95;
        } else {
          moveFactor = 0;
        }
      } else if (siegeGoal) {
        astarGoal = siegeGoal;
        desiredX = siegeGoal.x;
        desiredY = siegeGoal.y;
        const maxTurn = combat.aimTurnSpeed * dt;
        e.angle += clamp(angleDiff(e.angle, Math.atan2(desiredY - e.y, desiredX - e.x)), -maxTurn, maxTurn);
        moveFactor = e.siegeUnitKind === 'jungle' || e.siegeUnitKind === 'boss' ? 0.6 : 0.95;
      } else if (e.lastSeenTargetPos && (e.alertTimer > 0 || e.aggroLockTimer > 0)) {
        astarGoal = e.lastSeenTargetPos;
        desiredX = astarGoal.x;
        desiredY = astarGoal.y;
        const maxTurn = combat.aimTurnSpeed * dt;
        e.angle += clamp(angleDiff(e.angle, Math.atan2(desiredY - e.y, desiredX - e.x)), -maxTurn, maxTurn);
        moveFactor = 1.05;
      } else if (desiredPickup) {
        // 主動利用 A* 尋路前往地圖武器位置拾取升級裝備
        astarGoal = { x: desiredPickup.x, y: desiredPickup.y };
        desiredX = desiredPickup.x;
        desiredY = desiredPickup.y;
        const maxTurn = combat.aimTurnSpeed * dt;
        e.angle += clamp(angleDiff(e.angle, Math.atan2(desiredY - e.y, desiredX - e.x)), -maxTurn, maxTurn);
        moveFactor = 0.95;
      } else if (e.isAlly && p.hp > 0 && dist(e.x, e.y, p.x, p.y) > 130) {
        astarGoal = { x: p.x, y: p.y };
        desiredX = p.x;
        desiredY = p.y;
        const maxTurn = combat.aimTurnSpeed * dt;
        e.angle += clamp(angleDiff(e.angle, Math.atan2(desiredY - e.y, desiredX - e.x)), -maxTurn, maxTurn);
        moveFactor = 0.85;
      } else {
        const patrolGoal = this.getPatrolGoal(e, dt);
        if (patrolGoal) {
          patrolling = true;
          astarGoal = patrolGoal;
          desiredX = patrolGoal.x;
          desiredY = patrolGoal.y;
          moveFactor = AI_PATROL.speedMultiplier;
        }
      }

      // 使用 A* 路徑導航跨越高低差、階梯與橋樑
      if (moveFactor > 0 && astarGoal) {
        if (
          this.siege &&
          e.pathTiles.length > 0 &&
          this.isBlockedByAliveSiegeStructure(
            (e.pathTiles[0].gx + 0.5) * TILE,
            (e.pathTiles[0].gy + 0.5) * TILE,
            getMoveCheckRadius(e.radius)
          )
        ) {
          e.pathTiles = [];
          e.pathTimer = 0;
        }
        if (e.pathTimer <= 0 || e.pathTiles.length === 0) {
          e.pathTiles = this.findPathAStar(e.x, e.y, astarGoal.x, astarGoal.y);
          e.pathTimer = 0.35;
        }
        while (e.pathTiles.length > 1) {
          const wp = e.pathTiles[0];
          const wpX = (wp.gx + 0.5) * TILE;
          const wpY = (wp.gy + 0.5) * TILE;
          if (dist(e.x, e.y, wpX, wpY) < 24) {
            e.pathTiles.shift();
          } else {
            break;
          }
        }
        if (e.pathTiles.length > 0) {
          const curTileGx = Math.floor(e.x / TILE);
          const curTileGy = Math.floor(e.y / TILE);
          if (e.pathTiles.length > 1 && e.pathTiles[0].gx === curTileGx && e.pathTiles[0].gy === curTileGy) {
            e.pathTiles.shift();
          }
          const nextWp = e.pathTiles[0];
          desiredX = (nextWp.gx + 0.5) * TILE;
          desiredY = (nextWp.gy + 0.5) * TILE;
          if (!losTargetPos && !patrolling) {
            const maxTurn = combat.aimTurnSpeed * dt;
            e.angle += clamp(angleDiff(e.angle, Math.atan2(desiredY - e.y, desiredX - e.x)), -maxTurn, maxTurn);
          }
        }
      }

      if (patrolling) {
        const forward = Math.atan2(desiredY - e.y, desiredX - e.x);
        const scanAngle = forward + Math.sin(e.aiTimer * 2.6) * 0.42;
        const turn = AI_PATROL.turnSpeed * dt;
        e.angle += clamp(angleDiff(e.angle, scanAngle), -turn, turn);
      }

      if (activeWeapon.type === 'gun') {
        const aimDelta = Math.abs(angleDiff(e.lastAimAngle, e.angle));
        const sweepRefDist = losTargetPos ? clamp(bestLosDist, GUN_AIM.nearDistance, 400) : 220;
        const equivMoveDist = aimDelta * sweepRefDist;
        if (activeWeapon.def.kind === 'sniper') {
          const delta = Math.max(0, equivMoveDist - SNIPER_AIM.pointerDeadzonePx) * SNIPER_AIM.pointerMoveScale;
          if (delta > 0) {
            e.crosshairBloom = Math.min(
              activeWeapon.def.maxCrosshair - activeWeapon.def.baseCrosshair,
              e.crosshairBloom + Math.min(SNIPER_AIM.pointerMoveStepCap, delta)
            );
            e.bloomDelayTimer = SNIPER_AIM.settleDelaySeconds;
          }
        } else {
          e.crosshairBloom = Math.min(
            activeWeapon.def.maxCrosshair - activeWeapon.def.baseCrosshair,
            e.crosshairBloom + Math.min(18, Math.max(0, equivMoveDist - 2) * 0.09)
          );
        }
      }
      e.lastAimAngle = e.angle;

      const prevEX = e.x;
      const prevEY = e.y;
      const avoidDropOff = Boolean(losTargetPos && e.elevation > losTargetPos.elev + 0.25 && canHitRanged);
      if (moveFactor > 0) {
        const weaponSpeedMult = activeWeapon.def.moveSpeedMult;
        const moveAng = Math.atan2(desiredY - e.y, desiredX - e.x);
        this.framePushInputs.push({
          id: e.id,
          isPlayer: false,
          faction: e.faction,
          x: e.x,
          y: e.y,
          radius: e.radius,
          elevation: e.elevation,
          dirX: Math.cos(moveAng),
          dirY: Math.sin(moveAng),
        });
        const reactionPace = losTargetPos && e.reactionTimer > 0 ? 0.55 : 1;
        const freezeSpeedMult = e.freezeTimer > 0 ? 0.9 : 1.0;
        const stepDist = e.speed * difficulty.moveMultiplier * weaponSpeedMult * freezeSpeedMult * moveFactor * reactionPace * dt;
        const moved = this.moveCharacterWithElevation(
          e.x,
          e.y,
          e.elevation,
          Math.cos(moveAng) * stepDist,
          Math.sin(moveAng) * stepDist,
          e.radius
        );
        const dropBlocked = avoidDropOff && moved.elevation < e.elevation - 0.01;
        if (dropBlocked || dist(e.x, e.y, moved.x, moved.y) < stepDist * 0.25) {
          e.pathTimer = 0;
          const turnSign = (e.id.charCodeAt(e.id.length - 1) & 1) ? 1 : -1;
          const offsets = [turnSign * 1.05, -turnSign * 1.05, turnSign * 1.55, -turnSign * 1.55];
          for (const offset of offsets) {
            const alt = this.moveCharacterWithElevation(
              e.x,
              e.y,
              e.elevation,
              Math.cos(moveAng + offset) * stepDist,
              Math.sin(moveAng + offset) * stepDist,
              e.radius
            );
            const valid = !avoidDropOff || alt.elevation >= e.elevation - 0.01;
            if (valid && dist(e.x, e.y, alt.x, alt.y) >= stepDist * 0.2) {
              e.x = alt.x;
              e.y = alt.y;
              e.elevation = alt.elevation;
              break;
            }
          }
        } else {
          e.x = moved.x;
          e.y = moved.y;
          e.elevation = moved.elevation;
        }
      }

      const enemyMovedDist = dist(prevEX, prevEY, e.x, e.y);
      e.vx = dt > 0 ? (e.x - prevEX) / dt : 0;
      e.vy = dt > 0 ? (e.y - prevEY) / dt : 0;
      if (enemyMovedDist > 0.12) {
        if (activeWeapon.type === 'gun' && activeWeapon.def.kind === 'sniper') {
          const walkCap = Math.min(
            activeWeapon.def.maxCrosshair - activeWeapon.def.baseCrosshair,
            SNIPER_AIM.bodyMoveBloomCap
          );
          if (e.crosshairBloom <= walkCap) {
            e.crosshairBloom = Math.min(walkCap, e.crosshairBloom + enemyMovedDist * SNIPER_AIM.bodyMoveScale);
            e.bloomDelayTimer = Math.max(e.bloomDelayTimer, SNIPER_AIM.settleDelaySeconds);
          }
        }
        const stepPhase = PLAYER_MOVEMENT.stepDistance * 0.085;
        const previousStep = Math.floor(e.walkPhase / stepPhase);
        e.walkPhase += enemyMovedDist * 0.085;
        if (Math.floor(e.walkPhase / stepPhase) > previousStep) {
          sfx.footstep(this.getFootstepSurface(e.x, e.y), this.nearbySoundVolume(e.x, e.y) * 0.42);
        }
        e.moveIntensity = Math.min(1, e.moveIntensity + dt * 10);
      } else {
        e.moveIntensity = Math.max(0, e.moveIntensity - dt * 10);
      }

      // 路過或抵達地面武器點時自動拾取，並檢查是否踩踏冰氣孔
      if (this.mode !== 'siege') {
        this.enemyTryPickupWeapon(e);
      }
      this.applyIceVentFreezeCheck(e, false);

      const postPickupWeapon = e.weapons[e.activeHand];
      if (
        this.siege &&
        siegeStructureTarget &&
        !losTargetPos &&
        e.swapTimer <= 0 &&
        e.attackCooldown <= 0
      ) {
        const sd = dist(e.x, e.y, siegeStructureTarget.x, siegeStructureTarget.y);
        const targetAngle = Math.atan2(siegeStructureTarget.y - e.y, siegeStructureTarget.x - e.x);
        const angleErr = Math.abs(angleDiff(e.angle, targetAngle));
        if (postPickupWeapon.type === 'gun' && postPickupWeapon.reloadTimer <= 0 && sd <= 260) {
          if (postPickupWeapon.ammoInMag <= 0) {
            postPickupWeapon.reloadTimer = postPickupWeapon.def.reloadTime;
          } else if (angleErr <= AI_GUN_AIM.fireAngleToleranceRad) {
            e.attackCooldown =
              (1 / postPickupWeapon.def.fireRate) *
              AI_GUN_AIM.fireIntervalMultByKind[postPickupWeapon.def.kind];
            this.fireEnemyGunHitscan(e, e.angle, postPickupWeapon, sd);
            const spent = postPickupWeapon.def.kind === 'shotgun' ? postPickupWeapon.def.pellets : 1;
            postPickupWeapon.ammoInMag = Math.max(0, postPickupWeapon.ammoInMag - spent);
            if (postPickupWeapon.ammoInMag <= 0) postPickupWeapon.reloadTimer = postPickupWeapon.def.reloadTime;
          }
        } else if (postPickupWeapon.type === 'melee' && sd <= postPickupWeapon.def.reach + siegeStructureTarget.radius + 10) {
          e.attackCooldown = 1 / postPickupWeapon.def.swingRate;
          e.attackAnimDuration = 0.18;
          e.attackAnimTimer = 0.18;
          e.attackAnimKind = postPickupWeapon.def.kind;
          const auraMult =
            e.siegeUnitKind === 'minion' || e.siegeUnitKind === 'super_minion'
              ? this.getSiegeMinionDamageMult(e)
              : 1;
          this.damageSiegeStructure(
            siegeStructureTarget,
            Math.max(4, Math.round(Math.max(12, postPickupWeapon.def.damage) * auraMult)),
            e.id,
            e.faction
          );
        }
      } else if (!e.chargingMelee && e.swapTimer <= 0 && readyToAttack && losTargetPos && e.attackCooldown <= 0 && (targetIsPlayer || targetEntity)) {
        const targetAngle = Math.atan2(losTargetPos.y - e.y, losTargetPos.x - e.x);
        const angleErr = Math.abs(angleDiff(e.angle, targetAngle));
        const meleeHitReach =
          postPickupWeapon.type === 'melee'
            ? Math.max(76, postPickupWeapon.def.reach * e.sizeScale + 16)
            : 0;
        const canMeleeStrike =
          postPickupWeapon.type === 'melee' &&
          bestLosDist <= meleeHitReach &&
          Math.abs(e.elevation - losTargetPos.elev) <= 1.0 &&
          angleErr <= 0.9;
        if (canMeleeStrike) {
          const heldMeleeDef = postPickupWeapon.def;
          const meleeKind = heldMeleeDef.kind;
          e.attackCooldown = 1 / (heldMeleeDef.swingRate * (e.freezeTimer > 0 ? 0.9 : 1));
          const animDur = meleeKind === 'greatsword' ? 0.24 : 0.16;
          e.attackAnimDuration = animDur;
          e.attackAnimTimer = animDur;
          e.attackAnimKind = meleeKind;
          const giantMult = e.giantTimer > 0 ? 1.3 : 1.0;
          const meleeDmg = Math.round(heldMeleeDef.damage * giantMult);
          if (meleeKind !== 'shield') {
            this.pushSlash({
              x: e.x,
              y: e.y,
              angle: e.angle,
              arc: heldMeleeDef.arc,
              reach: heldMeleeDef.reach,
              color: e.color,
              life: animDur,
              maxLife: animDur,
              isUltimate: false,
              style: meleeKind === 'greatsword' ? 'sweep' : meleeKind === 'claw' ? 'claw' : 'thrust',
            });
          }
          const mVol = this.nearbySoundVolume(e.x, e.y);
          if (mVol > 0.05) {
            if (meleeKind === 'shield') sfx.shieldBash(mVol * 0.75);
            else sfx.slash(meleeKind, mVol * 0.75);
          }
          this.emitNetSfx('melee', e.x, e.y, meleeKind);
          if (targetIsPlayer) {
            if (meleeKind === 'shield') {
              const pushed = this.moveCharacterWithElevation(
                p.x,
                p.y,
                p.elevation,
                Math.cos(e.angle) * SHIELD_BASH_DISTANCE,
                Math.sin(e.angle) * SHIELD_BASH_DISTANCE,
                p.radius
              );
              p.x = pushed.x;
              p.y = pushed.y;
              p.elevation = pushed.elevation;
            }
            this.damagePlayer(meleeDmg, true, e.id, e.x, e.y);
          } else if (targetEntity) {
            const knockPower = meleeKind === 'shield' ? SHIELD_BASH_DISTANCE / 0.05 : 140;
            this.damageEnemy(
              targetEntity,
              meleeDmg,
              true,
              Math.cos(e.angle) * knockPower,
              Math.sin(e.angle) * knockPower,
              false,
              false,
              e.id,
              e.faction,
              e.x,
              e.y
            );
            if (meleeKind === 'shield' && targetEntity.hp > 0) {
              targetEntity.stunTimer = Math.max(targetEntity.stunTimer, 0.18);
            }
          }
        } else if (postPickupWeapon.type === 'gun' && canHitRanged && postPickupWeapon.reloadTimer <= 0) {
          if (postPickupWeapon.ammoInMag <= 0) {
            postPickupWeapon.reloadTimer = postPickupWeapon.def.reloadTime;
          } else if (angleErr <= AI_GUN_AIM.fireAngleToleranceRad) {
            e.attackCooldown =
              (1 / postPickupWeapon.def.fireRate) *
              AI_GUN_AIM.fireIntervalMultByKind[postPickupWeapon.def.kind];
            this.fireEnemyGunHitscan(e, e.angle, postPickupWeapon, bestLosDist);
            const spent = postPickupWeapon.def.kind === 'shotgun' ? postPickupWeapon.def.pellets : 1;
            postPickupWeapon.ammoInMag = Math.max(0, postPickupWeapon.ammoInMag - spent);
            if (postPickupWeapon.ammoInMag <= 0) {
              postPickupWeapon.reloadTimer = postPickupWeapon.def.reloadTime;
            }
          }
        }
      }
    }
  }

  private isBlackDragonBlockedAt(x: number, y: number, currentElev: number): boolean {
    if (x < 10 || x > this.map.width - 10 || y < 10 || y > this.map.height - 10) return true;
    const h = this.getHeightAtPoint(x, y);
    if (h.isWall) return true;
    if (h.totalHeight > currentElev && h.totalHeight - currentElev >= 1.0) return true;
    return false;
  }

  private updateProjectiles(dt: number, dealDamage = true) {
    const p = this.player;
    const nextProjectiles: Projectile[] = [];

    for (const proj of this.projectiles) {
      proj.life -= dt;
      if (proj.life <= 0) continue;

      if (proj.isBlackDragon) {
        const cooldowns = proj.targetHitCooldowns || (proj.targetHitCooldowns = {});
        for (const key of Object.keys(cooldowns)) {
          cooldowns[key] -= dt;
          if (cooldowns[key] <= 0) delete cooldowns[key];
        }
        const segs = proj.segments || (proj.segments = [{ x: proj.x, y: proj.y }]);
        const subSteps = 4;
        const subDt = dt / subSteps;
        let destroyed = false;

        for (let s = 0; s < subSteps; s++) {
          const prevX = proj.x;
          const prevY = proj.y;
          let bounced = false;

          const curH = this.getHeightAtPoint(proj.x, proj.y);
          if (!curH.isWall) {
            const rawSurface = curH.isCrate ? curH.totalHeight : curH.terrainHeight;
            const effectiveSurface = proj.startElevation < 0 ? rawSurface : Math.max(0, rawSurface);
            proj.minTraversedElevation = Math.min(proj.minTraversedElevation, effectiveSurface);
          }

          const nextX = proj.x + proj.vx * subDt;
          if (!proj.ignoresWalls && this.isBlackDragonBlockedAt(nextX, proj.y, proj.minTraversedElevation)) {
            proj.vx = -proj.vx;
            bounced = true;
          } else {
            proj.x = nextX;
          }

          const nextY = proj.y + proj.vy * subDt;
          if (!proj.ignoresWalls && this.isBlackDragonBlockedAt(proj.x, nextY, proj.minTraversedElevation)) {
            proj.vy = -proj.vy;
            bounced = true;
          } else {
            proj.y = nextY;
          }
          if (proj.x < 10 || proj.x > this.map.width - 10 || proj.y < 10 || proj.y > this.map.height - 10) {
            destroyed = true;
            break;
          }

          if (bounced) {
            const roll = Math.random();
            const angleOffset = roll < 1 / 3 ? Math.PI / 4 : roll < 2 / 3 ? 0 : -Math.PI / 4;
            if (angleOffset !== 0) {
              const speed = Math.hypot(proj.vx, proj.vy) || 340;
              const nextAng = Math.atan2(proj.vy, proj.vx) + angleOffset;
              proj.vx = Math.cos(nextAng) * speed;
              proj.vy = Math.sin(nextAng) * speed;
            }
            proj.bouncesLeft = (proj.bouncesLeft ?? 1) - 1;
            this.spawnBurst(proj.x, proj.y, '#4338CA', 5);
            if ((proj.bouncesLeft ?? 0) <= 0) {
              destroyed = true;
              break;
            }
          }

          proj.distanceTraveled = (proj.distanceTraveled ?? 0) + dist(prevX, prevY, proj.x, proj.y);
          if (proj.distanceTraveled >= (proj.maxDistance ?? 1050)) {
            destroyed = true;
            break;
          }

          if (dist(proj.x, proj.y, segs[0].x, segs[0].y) >= 12) {
            segs.unshift({ x: proj.x, y: proj.y });
            if (segs.length > 18) segs.pop();
          }

          // 龍頭傷 20、龍身傷 15（絕不傷隊友；結算後只保留動畫與反彈，不造成傷害）
          if (dealDamage && p.hp > 0 && proj.ownerId !== 'player' && areHostile(proj.ownerFaction, proj.ownerId, p.faction, 'player')) {
            if (!cooldowns['player']) {
              const hitInfo = evaluateBlackDragonHit(proj, segs, prevX, prevY, p.x, p.y, p.radius);
              if (hitInfo) {
                cooldowns['player'] = 0.25;
                this.damagePlayer(hitInfo.hitDmg, true, proj.ownerId, hitInfo.hitOriginX, hitInfo.hitOriginY);
              }
            }
          }

          if (dealDamage) {
            for (const e of [...this.enemies]) {
              if (e.id === proj.ownerId || cooldowns[e.id]) continue;
              if (!areHostile(proj.ownerFaction, proj.ownerId, e.faction, e.id)) continue;
              const hitInfo = evaluateBlackDragonHit(proj, segs, prevX, prevY, e.x, e.y, e.radius);
              if (hitInfo) {
                cooldowns[e.id] = 0.25;
                this.damageEnemy(
                  e,
                  hitInfo.hitDmg,
                  true,
                  proj.vx * 0.05,
                  proj.vy * 0.05,
                  false,
                  true,
                  proj.ownerId,
                  proj.ownerFaction,
                  hitInfo.hitOriginX,
                  hitInfo.hitOriginY
                );
              }
            }
            if (this.siege && (proj.ownerFaction === 'royal' || proj.ownerFaction === 'shadow')) {
              for (const st of this.siege.structures) {
                if (!st.alive || st.faction === proj.ownerFaction || cooldowns[st.id]) continue;
                const hitInfo = evaluateBlackDragonHit(proj, segs, prevX, prevY, st.x, st.y, st.radius);
                if (hitInfo) {
                  cooldowns[st.id] = 0.35;
                  this.damageSiegeStructure(st, hitInfo.hitDmg, proj.ownerId, proj.ownerFaction);
                }
              }
            }
          }
        }

        if (!destroyed) nextProjectiles.push(proj);
        continue;
      }

      proj.prevX = proj.x;
      proj.prevY = proj.y;

      const subSteps = 2;
      let destroyed = false;

      for (let s = 0; s < subSteps; s++) {
        const prevSubX = proj.x;
        const prevSubY = proj.y;
        const subDt = dt / subSteps;
        proj.x += proj.vx * subDt;
        proj.y += proj.vy * subDt;

        if (proj.x < 0 || proj.x > this.map.width || proj.y < 0 || proj.y > this.map.height) {
          destroyed = true;
          break;
        }

        const wallHit = proj.ignoresWalls ? null : this.findEarliestWallHit(prevSubX, prevSubY, proj.x, proj.y);
        if (wallHit) {
          this.spawnBurst(wallHit.x, wallHit.y, proj.color, 4);
          destroyed = true;
          break;
        }

        const h = this.getHeightAtPoint(proj.x, proj.y);
        if (!h.isWall) {
          const rawSurface = h.isCrate ? h.totalHeight : h.terrainHeight;
          const effectiveSurface = proj.startElevation < 0 ? rawSurface : Math.max(0, rawSurface);
          proj.minTraversedElevation = Math.min(proj.minTraversedElevation, effectiveSurface);
        }
        const heightDiff = h.totalHeight - proj.minTraversedElevation;
        if (!proj.ignoresWalls && (h.isWall || heightDiff > 1.0)) {
          this.spawnBurst(proj.x, proj.y, proj.color, 4);
          destroyed = true;
          break;
        }

        if (dealDamage && proj.healAllies) {
          const healAmt = Math.max(35, Math.round(proj.damage * 1.1));
          if (p.hp > 0 && !proj.hitIds.has('player') && !areHostile(proj.ownerFaction, proj.ownerId, p.faction, 'player')) {
            const hit = segmentCircleHit(proj.prevX, proj.prevY, proj.x, proj.y, p.x, p.y, p.radius + proj.radius * 0.7);
            if (hit.hit) {
              proj.hitIds.add('player');
              p.hp = Math.min(p.maxHp, p.hp + healAmt);
              this.spawnText(p.x, p.y - 30, `+${healAmt}`, '#4ADE80', 0.95, true);
            }
          }
          for (const ally of this.enemies) {
            if (ally.id === proj.ownerId || proj.hitIds.has(ally.id)) continue;
            if (areHostile(proj.ownerFaction, proj.ownerId, ally.faction, ally.id)) continue;
            const hit = segmentCircleHit(proj.prevX, proj.prevY, proj.x, proj.y, ally.x, ally.y, ally.radius + proj.radius * 0.7);
            if (hit.hit) {
              proj.hitIds.add(ally.id);
              ally.hp = Math.min(ally.maxHp, ally.hp + healAmt);
              this.spawnText(ally.x, ally.y - 26, `+${healAmt}`, '#4ADE80', 0.85, true);
            }
          }
        }

        const canHitPlayer =
          dealDamage &&
          p.hp > 0 && proj.ownerId !== 'player' &&
          !proj.hitIds.has('player') &&
          (!proj.noFriendlyFire || areHostile(proj.ownerFaction, proj.ownerId, p.faction, 'player'));
        if (canHitPlayer && p.elevation - proj.minTraversedElevation < 2.0) {
          const hit = segmentCircleHit(proj.prevX, proj.prevY, proj.x, proj.y, p.x, p.y, p.radius + proj.radius * 0.5);
          if (hit.hit) {
            proj.hitIds.add('player');
            const isAllyOrb = !areHostile(proj.ownerFaction, proj.ownerId, p.faction, 'player');
            this.damagePlayer(isAllyOrb ? Math.round(proj.damage * 0.5) : proj.damage, false, proj.ownerId, proj.prevX, proj.prevY);
            if (proj.pierce > 0) {
              proj.pierce -= 1;
            } else {
              destroyed = true;
              break;
            }
          }
        }

        if (dealDamage) {
          for (const e of [...this.enemies]) {
            if (e.id === proj.ownerId || proj.hitIds.has(e.id)) continue;
            if (e.elevation - proj.minTraversedElevation >= 2.0) continue;

            const hit = segmentCircleHit(
              proj.prevX,
              proj.prevY,
              proj.x,
              proj.y,
              e.x,
              e.y,
              e.radius + proj.radius * 0.6
            );
            if (hit.hit) {
              proj.hitIds.add(e.id);
              this.damageEnemy(
                e,
                proj.damage,
                false,
                proj.vx * 0.04,
                proj.vy * 0.04,
                false,
                Boolean(proj.noFriendlyFire),
                proj.ownerId,
                proj.ownerFaction,
                proj.prevX,
                proj.prevY
              );

              if (proj.pierce > 0) {
                proj.pierce -= 1;
              } else {
                destroyed = true;
                break;
              }
            }
          }
          if (!destroyed && this.siege && (proj.ownerFaction === 'royal' || proj.ownerFaction === 'shadow')) {
            for (const st of this.siege.structures) {
              if (!st.alive || st.faction === proj.ownerFaction || proj.hitIds.has(st.id)) continue;
              const hit = segmentCircleHit(proj.prevX, proj.prevY, proj.x, proj.y, st.x, st.y, st.radius + proj.radius * 0.5);
              if (hit.hit) {
                proj.hitIds.add(st.id);
                this.damageSiegeStructure(st, proj.damage, proj.ownerId, proj.ownerFaction);
                if (proj.pierce > 0) {
                  proj.pierce -= 1;
                } else {
                  destroyed = true;
                  break;
                }
              }
            }
          }
        }
        if (destroyed) break;
      }

      if (!destroyed) nextProjectiles.push(proj);
    }

    this.projectiles = nextProjectiles;
  }

  public render(ctx: CanvasRenderingContext2D, width: number, height: number) {
    ctx.save();
    ctx.fillStyle = '#0D1017';
    ctx.fillRect(0, 0, width, height);

    const shakeX = (Math.random() - 0.5) * this.camera.shake * 2;
    const shakeY = (Math.random() - 0.5) * this.camera.shake * 2;
    const renderCam = this.clampCameraToMap(this.camera.x, this.camera.y, width, height);

    ctx.translate(width / 2 + shakeX, height / 2 + shakeY);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(-renderCam.x, -renderCam.y);

    // 1–4 & 6–7: 繪製統一格線地板、河道橋樑、多層高台、階梯、草叢、樹幹、大箱子與特色牆柱
    renderMapBaseLayer(ctx, this.map, false, this.time);

    if (this.siege) {
      drawSiegeFountains(ctx, this.siege.spec.fountains, this.time);
      drawSiegeZones(ctx, this.siege.zones, this.time);
      const targetPosMap = new Map<string, { x: number; y: number }>();
      if (this.player.hp > 0) targetPosMap.set('player', { x: this.player.x, y: this.player.y });
      for (const e of this.enemies) {
        if (e.hp > 0) targetPosMap.set(e.id, { x: e.x, y: e.y });
      }
      drawSiegeStructures(
        ctx,
        this.siege.structures,
        this.player.faction === 'shadow' ? 'shadow' : 'royal',
        { x: this.player.x, y: this.player.y },
        targetPosMap,
        this.time
      );
    }

    // 8. 地面武器與可重複彈藥補給
    for (const pk of this.pickups) {
      drawPickup(ctx, pk);
    }

    // 9. 近戰特效
    for (const s of this.slashes) {
      drawSlashEffect(ctx, s);
    }

    // 10. 電腦敵我士兵及技能狀態
    for (const e of this.enemies) {
      if (!e.chargingMelee && e.qi < e.maxQi - 0.5) {
        drawQiRecovery(ctx, e.x, e.y, e.radius, this.time);
      }

      const skillVisuals = this.getActorSkillVisuals(e);
      this.drawActorSkillEffects(ctx, e, skillVisuals);
      if (e.chargeReady || e.chargingMelee) {
        drawMeleeChargeAura(
          ctx,
          e.x,
          e.y,
          e.baseRadius * skillVisuals.sizeScale,
          this.time,
          e.faction,
          e.chargeReady,
          clamp(1 - e.qi / e.maxQi, 0, 1)
        );
      }

      const eActive = e.weapons[e.activeHand];
      const eGun = this.getEnemyGun(e);
      const eMelee = this.getEnemyMelee(e);
      const eReloading = eActive.type === 'gun' && eActive.reloadTimer > 0;
      const eReloadProg =
        eActive.type === 'gun' && eActive.reloadTimer > 0
          ? clamp(1 - eActive.reloadTimer / eActive.def.reloadTime, 0, 1)
          : 0;
      const eSwapProg =
        e.swapTimer > 0 && e.swapDuration > 0
          ? clamp(1 - e.swapTimer / e.swapDuration, 0.01, 1)
          : 0;

      const eAtkProg =
        e.attackAnimTimer > 0 && e.attackAnimDuration > 0
          ? clamp(1 - e.attackAnimTimer / e.attackAnimDuration, 0, 1)
          : 0;

      drawCharacter(ctx, {
        x: e.x,
        y: e.y,
        radius: e.baseRadius * skillVisuals.sizeScale,
        morphScale: skillVisuals.sizeScale,
        shadowDodge: skillVisuals.shadowDodge,
        angle: e.angle,
        bodyColor: e.hitFlash > 0 ? '#FFFFFF' : e.characterSkin.bodyColor,
        role: e.isAlly ? 'ALLY' : 'ENEMY',
        holdingMelee: eActive.type === 'melee',
        shadowActive: e.shadowCloneTimer > 0,
        time: this.time,
        isReloading: eReloading,
        reloadProgress: eReloadProg,
        isBlinded: e.blindTimer > 0,
        isFrozen: e.freezeTimer > 0,
        gunKind: eActive.type === 'gun' ? eActive.def.kind : eGun?.def.kind,
        meleeKind: eActive.type === 'melee' ? eActive.def.kind : eMelee?.def.kind,
        skin: e.characterSkin,
        walkPhase: e.walkPhase,
        moveIntensity: e.moveIntensity,
        swapProgress: eSwapProg,
        attackAnimProgress: eAtkProg,
        attackAnimKind: e.attackAnimKind,
        gunfireTimer: e.gunfireTimer,
        eagleEyeRemaining: e.eagleEyeTimer,
      });

      if (e.royalShieldTimer > 0) {
        drawRoyalShield(ctx, e, this.time);
      }
      if (e.chargeReady) {
        drawMeleeChargeSparks(ctx, e.x, e.y, e.baseRadius * skillVisuals.sizeScale, this.time, e.faction);
      }

      const bw = 40;
      const bx = e.x - bw / 2;
      const by = e.y - e.radius - 13;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(bx, by, bw, 5);
      ctx.fillStyle = e.isAlly ? '#38BDF8' : e.color;
      ctx.fillRect(bx, by, bw * clamp(e.hp / e.maxHp, 0, 1), 5);

      const nameplateColor =
        e.faction === 'royal'
          ? '#FFFFFF'
          : e.faction === 'shadow'
            ? '#6E146B'
            : '#92400E';
      const nameplateStroke =
        e.faction === 'royal'
          ? 'rgba(0, 0, 0, 0.92)'
          : e.faction === 'shadow'
            ? 'rgba(241, 245, 249, 0.95)'
            : 'rgba(254, 243, 199, 0.95)';
      drawOutlinedText(
        ctx,
        e.name.replace(/\s*[（(]預設[）)]$/, ''),
        e.x,
        by - 5,
        nameplateColor,
        11,
        'center',
        nameplateStroke
      );
    }

    // 11. 玩家角色及技能狀態
    const p = this.player;
    const facHex = p.characterSkin.bodyColor || FACTIONS[p.faction].accentHex;

    if (p.hp > 0) {
      if (!this.chargeSessionAllowed && p.qi < p.maxQi - 0.5) {
        drawQiRecovery(ctx, p.x, p.y, p.radius, this.time);
      }

      const skillVisuals = this.getActorSkillVisuals(p);
      this.drawActorSkillEffects(ctx, p, skillVisuals);
      if (p.chargeReady || (p.chargingMelee && this.chargeSessionAllowed)) {
        drawMeleeChargeAura(
          ctx,
          p.x,
          p.y,
          p.baseRadius * skillVisuals.sizeScale,
          this.time,
          p.faction,
          p.chargeReady,
          clamp(1 - p.qi / p.maxQi, 0, 1)
        );
      }

      const weapon = p.weapons[p.activeHand];
      const isReloading = weapon.type === 'gun' && weapon.reloadTimer > 0;
      const playerReloadProg = isReloading ? clamp(1 - weapon.reloadTimer / weapon.def.reloadTime, 0, 1) : 0;
      const playerSwapProg = p.swapTimer > 0 && p.swapDuration > 0 ? clamp(1 - p.swapTimer / p.swapDuration, 0.01, 1) : 0;
      const playerAtkProg =
        p.attackAnimTimer > 0 && p.attackAnimDuration > 0
          ? clamp(1 - p.attackAnimTimer / p.attackAnimDuration, 0, 1)
          : 0;

      drawCharacter(ctx, {
        x: p.x,
        y: p.y,
        radius: p.baseRadius * skillVisuals.sizeScale,
        morphScale: skillVisuals.sizeScale,
        shadowDodge: skillVisuals.shadowDodge,
        angle: p.angle,
        bodyColor: p.invulnTimer > 0 && Math.floor(this.time * 16) % 2 === 0 ? '#FFFFFF' : facHex,
        role: 'PLAYER',
        holdingMelee: weapon.type === 'melee',
        shadowActive: p.shadowCloneTimer > 0,
        time: this.time,
        isReloading,
        reloadProgress: playerReloadProg,
        isBlinded: false,
        isFrozen: p.freezeTimer > 0,
        gunKind: weapon.type === 'gun' ? weapon.def.kind : undefined,
        meleeKind: weapon.type === 'melee' ? weapon.def.kind : undefined,
        skin: p.characterSkin,
        walkPhase: p.walkPhase,
        moveIntensity: p.moveIntensity,
        swapProgress: playerSwapProg,
        attackAnimProgress: playerAtkProg,
        attackAnimKind: p.attackAnimKind,
        gunfireTimer: p.gunfireTimer,
        eagleEyeRemaining: p.eagleEyeTimer,
      });

      if (p.royalShieldTimer > 0) {
        drawRoyalShield(ctx, p, this.time);
      }
      if (p.chargeReady) {
        drawMeleeChargeSparks(ctx, p.x, p.y, p.baseRadius * skillVisuals.sizeScale, this.time, p.faction);
      }

      if (isReloading) {
        const barW = 42;
        const barX = p.x - barW / 2;
        const barY = p.y - p.radius - 16;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fillRect(barX, barY, barW, 5);
        ctx.fillStyle = '#FBBF24';
        ctx.fillRect(barX, barY, barW * playerReloadProg, 5);
        drawOutlinedText(ctx, '裝彈中', p.x, barY - 4, '#FBBF24', 11, 'center');
      }
    }

    // 12. 敵我共用極速線狀子彈
    drawBeamTracers(ctx, this.beams);

    // 13. 陣營近武波動（黃色光彈與深紫藍長龍黑龍波）
    drawProjectiles(ctx, this.projectiles, this.time);
    drawSkillTraces(ctx, this.skillTraces, this.time);
    drawParticles(ctx, this.particles);

    // 14. 高 z-index 樹葉（依不同地圖呈現相應樹冠）
    renderMapCanopies(ctx, this.map, p);

    drawFloatingTexts(ctx, this.floatingTexts);

    ctx.restore();

    if (p.hp > 0 && p.blindTimer > 0 && p.blindDuration > 0 && this.status === 'PLAYING') {
      const flashAlpha = clamp(p.blindTimer / p.blindDuration, 0, 1);
      ctx.save();
      ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha.toFixed(3)})`;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }

    if (this.status === 'PLAYING') {
      const weapon = p.weapons[p.activeHand];
      if (weapon.type === 'gun') {
        const radiusPx = this.getPlayerGunSpread(weapon.def) * GUN_AIM.spreadScale;
        let { x: aimX, y: aimY } = this.mouseScreen;
        if (weapon.def.kind === 'rifle' && weapon.reloadTimer <= 0 && weapon.ammoInMag > 0) {
          const playerScreenX = width / 2 + (p.x - this.camera.x) * this.camera.zoom;
          const playerScreenY = height / 2 + (p.y - this.camera.y) * this.camera.zoom;
          const dx = aimX - playerScreenX;
          const dy = aimY - playerScreenY;
          const recoil = this.getPlayerRifleDrift();
          aimX = playerScreenX + dx * Math.cos(recoil) - dy * Math.sin(recoil);
          aimY = playerScreenY + dx * Math.sin(recoil) + dy * Math.cos(recoil);
        }

        drawCrosshair(
          ctx,
          aimX,
          aimY,
          this.time,
          radiusPx,
          weapon.reloadTimer > 0,
          weapon.ammoInMag <= 0,
          p.eagleEyeTimer > 0,
          p.comboEmpowerTimer > 0
        );
      }
    }
  }

  private resolveSkinById(skinId: string, faction: FactionId): CharacterSkin {
    return ALL_SKINS_BY_ID.get(skinId) || FACTION_CHARACTERS[faction][0];
  }

  private serializeWeaponSlot(w: EquippedWeapon): NetActorSnapshot['slots'][0] {
    if (w.type === 'gun') {
      return {
        t: 'g',
        id: w.def.id,
        ammo: w.ammoInMag,
        reload: w.reloadTimer > 0 ? round1(w.reloadTimer * 10) / 10 : 0,
      };
    }
    return {
      t: 'm',
      id: w.def.id,
      ...(w.def.kind === 'shield' ? { dur: Math.round(w.durability) } : {}),
    };
  }

  private deserializeWeaponSlot(slot: NetEquippedSlot): EquippedWeapon {
    if (slot.t === 'g') {
      const def = ALL_GUNS_BY_ID.get(slot.id) || DEFAULT_PISTOL;
      return {
        type: 'gun',
        def,
        ammoInMag: clamp(slot.ammo ?? def.magSize, 0, def.magSize),
        reloadTimer: Math.max(0, slot.reload ?? 0),
      };
    }
    const def = ALL_MELEES_BY_ID.get(slot.id) || DEFAULT_KNIFE;
    return {
      type: 'melee',
      def,
      durability: def.kind === 'shield' ? clamp(slot.dur ?? 100, 0, 100) : 0,
    };
  }

  private initRemoteHumans(multiplayer: MultiplayerEngineConfig) {
    for (const peer of multiplayer.peers) {
      if (peer.peerId === multiplayer.hostPeerId) continue;
      const effFaction: FactionId = this.siege && peer.faction === 'mercenary' ? 'royal' : peer.faction;
      const sp = this.siege
        ? this.siege.spec.fountains[effFaction === 'shadow' ? 'shadow' : 'royal']
        : this.pickBestDispersedSpawn(effFaction);
      const siegeLoadout = this.siege
        ? sanitizeSiegeLoadout(effFaction === 'shadow' ? 'shadow' : 'royal', peer.siegeLoadout ?? getDefaultSiegeLoadout(effFaction === 'shadow' ? 'shadow' : 'royal', peer.characterSkin.id))
        : undefined;
      if (this.siege && siegeLoadout) {
        this.siege.remoteStates.set(peer.peerId, createHeroSiegeState(siegeLoadout));
      }
      const rt: RemoteHumanRuntime = {
        peerId: peer.peerId,
        entityId: `human_${peer.peerId}`,
        name: peer.name,
        faction: effFaction,
        reputationChanges: { royal: 0, shadow: 0, mercenary: 0 },
        characterSkin: peer.characterSkin,
        lives: this.siege ? 999 : 3,
        maxLives: this.siege ? 999 : 3,
        reserveAmmo: this.siege ? 45 : 30,
        maxReserveAmmo: this.siege ? 60 : 45,
        score: 0,
        totalDamage: 0,
        kills: 0,
        comboCount: 0,
        maxCombo: 0,
        comboTimer: 0,
        respawnTimer: 0,
        rifleRecoilAngle: 0,
        chargeSessionAllowed: false,
        meleeHeldSeconds: 0,
        lastAttackAt: -10,
        delayCancelReady: false,
        comboEmpowerTimer: 0,
        delayCancelBonus: 0.25,
        prevAimX: sp.x + 120,
        prevAimY: sp.y,
        lastAimBloomAt: -10,
        wasMouseDown: false,
        lastClickSeq: 0,
        lastReloadSeq: 0,
        lastSwapSeq: 0,
        lastPickupSeq: 0,
        lastDropSeq: 0,
        lastTacticalSeq: 0,
        lastUltSeq: 0,
        lastRecallSeq: 0,
        lastUpgradeSeq: 0,
        siegeLoadout,
        input: {
          moveX: 0,
          moveY: 0,
          aimX: sp.x + 120,
          aimY: sp.y,
          mouseDown: false,
          clickSeq: 0,
          reloadSeq: 0,
          swapSeq: 0,
          pickupSeq: 0,
          dropSeq: 0,
        },
      };
      this.remoteHumans.set(peer.peerId, rt);
      this.spawnRemoteHumanEntity(rt, true);
    }
  }

  private spawnRemoteHumanEntity(rt: RemoteHumanRuntime, initial: boolean) {
    const sp = this.siege
      ? this.siege.spec.fountains[rt.faction === 'shadow' ? 'shadow' : 'royal']
      : this.pickBestDispersedSpawn(rt.faction);
    const fac = FACTIONS[rt.faction];
    const startGun = (rt.siegeLoadout && ALL_GUNS_BY_ID.get(rt.siegeLoadout.gunId)) || GUNS.find((g) => g.id === fac.startGunId) || DEFAULT_PISTOL;
    const startMelee = (rt.siegeLoadout && ALL_MELEES_BY_ID.get(rt.siegeLoadout.meleeId)) || MELEES.find((m) => m.id === fac.startMeleeId) || DEFAULT_KNIFE;
    const elev = this.getWalkableElevation(sp.x, sp.y);
    const rSiegeState = this.siege?.remoteStates.get(rt.peerId);
    const maxHp = rSiegeState ? computeSiegeMaxHp(rSiegeState) : 100;
    const entity: EnemyEntity = {
      id: rt.entityId,
      isHumanPlayer: !rt.disconnected,
      peerId: rt.peerId,
      name: rt.name,
      archetype: 'trooper',
      faction: rt.faction,
      isAlly: !areHostile(rt.faction, rt.entityId, this.player.faction, 'player'),
      activeHand: 0,
      weapons: [equipGun(startGun), { type: 'melee', def: startMelee, durability: startMelee.kind === 'shield' ? 100 : 0 }],
      swapTimer: 0,
      swapDuration: 0,
      x: sp.x,
      y: sp.y,
      vx: 0,
      vy: 0,
      baseRadius: CHAR_BASE_RADIUS,
      radius: CHAR_BASE_RADIUS,
      sizeScale: 1,
      angle: 0,
      walkPhase: 0,
      moveIntensity: 0,
      elevation: elev,
      hp: maxHp,
      maxHp,
      qi: 100,
      maxQi: 100,
      chargingMelee: false,
      chargeReady: false,
      speed: PLAYER_MOVEMENT.speed,
      attackCooldown: 0,
      aiTimer: 0,
      lastSeenTargetPos: null,
      alertTimer: 0,
      hasLosToTarget: false,
      visibleTargetId: null,
      reactionTimer: 0,
      focusedTargetId: null,
      aggroLockTimer: 0,
      pathTiles: [],
      pathTimer: 0,
      patrolAnchor: { x: sp.x, y: sp.y },
      patrolTarget: null,
      patrolTimer: 0,
      royalShieldTimer: 0,
      eagleEyeTimer: 0,
      shadowCloneTimer: 0,
      vampireTimer: 0,
      shrinkTimer: 0,
      giantTimer: 0,
      blindTimer: 0,
      stunTimer: 0,
      freezeTimer: 0,
      invulnTimer: initial ? 1.5 : 2.4,
      hitFlash: 0,
      gunfireTimer: 0,
      crosshairBloom: 0,
      bloomDelayTimer: 0,
      lastAimAngle: 0,
      attackAnimTimer: 0,
      attackAnimDuration: 0,
      attackAnimKind: null,
      color: fac.accentHex,
      characterSkin: rt.characterSkin,
      ...(this.siege ? { siegeUnitKind: 'hero' as const, siegeLoadout: rt.siegeLoadout } : {}),
    };
    this.enemies.push(entity);
    rt.prevAimX = sp.x + 120;
    rt.prevAimY = sp.y;
    rt.lastDropSeq = rt.input.dropSeq ?? 0;
    if (!initial) {
      this.spawnBurst(sp.x, sp.y, '#FFFFFF', 14);
    }
  }

  public setRemoteInput(peerId: string, input: RemotePlayerInput) {
    const rt = this.remoteHumans.get(peerId);
    if (!rt) return;
    if (rt.startingReputation === undefined && input.startingReputation !== undefined &&
        Number.isSafeInteger(input.startingReputation)) {
      rt.startingReputation = input.startingReputation;
    }
    rt.input = input;
  }

  public markRemoteHumanDisconnected(peerId: string) {
    const rt = this.remoteHumans.get(peerId);
    if (!rt) return;
    rt.disconnected = true;
    rt.wasMouseDown = false;
    rt.chargeSessionAllowed = false;
    rt.input.mouseDown = false;
    rt.input.moveX = 0;
    rt.input.moveY = 0;
    const ent = this.enemies.find((e) => e.id === rt.entityId);
    if (ent) {
      ent.isHumanPlayer = false;
      ent.chargingMelee = false;
      ent.chargeReady = false;
      this.spawnText(ent.x, ent.y - 36, `${rt.name} 暫時斷線 (AI 託管)`, '#FBBF24', 1.0);
    }
    this.emitHud();
  }

  public rejoinRemoteHuman(peerId: string) {
    const rt = this.remoteHumans.get(peerId);
    if (!rt) return;
    rt.disconnected = false;
    rt.wasMouseDown = false;
    rt.chargeSessionAllowed = false;
    rt.meleeHeldSeconds = 0;
    rt.lastClickSeq = 0;
    rt.lastReloadSeq = 0;
    rt.lastSwapSeq = 0;
    rt.lastPickupSeq = 0;
    rt.lastDropSeq = 0;
    rt.lastTacticalSeq = 0;
    rt.lastUltSeq = 0;
    rt.lastRecallSeq = 0;
    rt.lastUpgradeSeq = 0;
    rt.input.mouseDown = false;
    rt.input.moveX = 0;
    rt.input.moveY = 0;
    const ent = this.enemies.find((e) => e.id === rt.entityId);
    if (ent) {
      ent.isHumanPlayer = true;
      ent.chargingMelee = false;
      ent.chargeReady = false;
      this.spawnText(ent.x, ent.y - 36, `${rt.name} 已重返戰場!`, '#4ADE80', 1.1);
    } else if (rt.respawnTimer <= 0 && rt.lives > 0) {
      this.spawnRemoteHumanEntity(rt, false);
    }
    this.forceNextKeyframe = true;
    this.emitHud();
  }

  public removeRemoteHuman(peerId: string) {
    const rt = this.remoteHumans.get(peerId);
    if (!rt) return;
    const idx = this.enemies.findIndex((e) => e.id === rt.entityId);
    if (idx !== -1) {
      const removed = this.enemies[idx];
      this.enemies.splice(idx, 1);
      this.spawnText(removed.x, removed.y - 36, `${rt.name} 已離線`, '#94A3B8', 1.0);
    }
    this.remoteHumans.delete(peerId);
    this.checkVictoryCondition();
    this.emitHud();
  }

  private tickRemoteHumanRespawns(dt: number) {
    for (const rt of this.remoteHumans.values()) {
      if (this.siege) {
        const rState = this.siege.remoteStates.get(rt.peerId);
        if (rState && (rt.input.upgradeSeq ?? 0) > rt.lastUpgradeSeq && rt.input.upgradeTrack && rt.respawnTimer > 0) {
          rt.lastUpgradeSeq = rt.input.upgradeSeq ?? 0;
          tryPurchaseSiegeUpgrade(rState, rt.input.upgradeTrack);
        }
      }
      if (rt.respawnTimer <= 0) continue;
      rt.respawnTimer = Math.max(0, rt.respawnTimer - dt);
      if (rt.respawnTimer === 0 && rt.lives > 0) {
        rt.reserveAmmo = this.siege ? 45 : 30;
        rt.comboEmpowerTimer = 0;
        rt.delayCancelReady = false;
        rt.rifleRecoilAngle = 0;
        rt.chargeSessionAllowed = false;
        rt.meleeHeldSeconds = 0;
        this.spawnRemoteHumanEntity(rt, false);
      }
    }
  }

  private applyRemoteHumanMeleeHitbox(
    e: EnemyEntity,
    ox: number,
    oy: number,
    attackerElev: number,
    aimAngle: number,
    arc: number,
    reach: number,
    damage: number,
    isShieldPush = false
  ) {
    const knockPower = isShieldPush ? SHIELD_BASH_DISTANCE / 0.05 : 200;
    const p = this.player;
    if (p.hp > 0 && Math.abs(attackerElev - p.elevation) <= 1.0 && dist(ox, oy, p.x, p.y) <= reach + p.radius) {
      const ang = Math.atan2(p.y - oy, p.x - ox);
      if (Math.abs(angleDiff(aimAngle, ang)) <= arc * 0.62) {
        if (isShieldPush && areHostile(e.faction, e.id, p.faction, 'player')) {
          const pushed = this.moveCharacterWithElevation(
            p.x,
            p.y,
            p.elevation,
            Math.cos(ang) * SHIELD_BASH_DISTANCE,
            Math.sin(ang) * SHIELD_BASH_DISTANCE,
            p.radius
          );
          p.x = pushed.x;
          p.y = pushed.y;
          p.elevation = pushed.elevation;
        }
        if (areHostile(e.faction, e.id, p.faction, 'player')) {
          this.damagePlayer(damage, true, e.id, ox, oy);
        } else if (!isShieldPush && damage > 0) {
          this.damagePlayer(Math.max(1, Math.round(damage * 0.5)), true, e.id, ox, oy, true);
        }
      }
    }
    for (const other of [...this.enemies]) {
      if (other.id === e.id) continue;
      if (Math.abs(attackerElev - other.elevation) > 1.0) continue;
      if (dist(ox, oy, other.x, other.y) <= reach + other.radius) {
        const ang = Math.atan2(other.y - oy, other.x - ox);
        if (Math.abs(angleDiff(aimAngle, ang)) <= arc * 0.62) {
          this.damageEnemy(
            other,
            damage,
            true,
            Math.cos(ang) * knockPower,
            Math.sin(ang) * knockPower,
            false,
            false,
            e.id,
            e.faction,
            ox,
            oy
          );
          if (isShieldPush && other.hp > 0) {
            other.stunTimer = Math.max(other.stunTimer, 0.18);
          }
        }
      }
    }
  }

  private remoteHumanPickup(e: EnemyEntity, rt: RemoteHumanRuntime) {
    let bestIdx = -1;
    let bestD = 70;
    for (let i = 0; i < this.pickups.length; i++) {
      const d = dist(e.x, e.y, this.pickups[i].x, this.pickups[i].y);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return;
    const item = this.pickups[bestIdx];
    if (
      item.kind === 'ammo' &&
      rt.reserveAmmo >= rt.maxReserveAmmo &&
      e.weapons.every((w) => w.type !== 'gun' || w.ammoInMag >= w.def.magSize)
    ) {
      return;
    }

    this.pickups.splice(bestIdx, 1);
    if (item.kind === 'ammo') {
      const added = item.amount || 30;
      rt.reserveAmmo = Math.min(rt.maxReserveAmmo, rt.reserveAmmo + added);
      if (item.ammoSpawnIndex !== undefined) {
        const pad = this.map.ammoSpawns[item.ammoSpawnIndex];
        if (pad) {
          pad.active = false;
          pad.respawnTimer = 10.0;
        }
      }
    } else if (item.kind === 'gun' && item.gunDef) {
      this.dropWeapon(e.weapons[e.activeHand], item.x, item.y);
      e.weapons[e.activeHand] = equipGun(item.gunDef, item.ammoInMag ?? item.gunDef.magSize);
      e.crosshairBloom = 0;
      e.bloomDelayTimer = 0;
      e.chargingMelee = false;
      e.chargeReady = false;
    } else if (item.kind === 'melee' && item.meleeDef) {
      this.dropWeapon(e.weapons[e.activeHand], item.x, item.y);
      e.weapons[e.activeHand] = {
        type: 'melee',
        def: item.meleeDef,
        durability: item.meleeDef.kind === 'shield' ? clamp(item.durability ?? 100, 1, 100) : 0,
      };
      e.chargingMelee = false;
      e.chargeReady = false;
    }
  }

  private remoteHumanDropActiveWeapon(e: EnemyEntity, rt: RemoteHumanRuntime) {
    const weapon = e.weapons[e.activeHand];
    if (weapon.def.kind === 'pistol' || weapon.def.kind === 'knife') {
      this.spawnText(e.x, e.y - 36, `預設${weapon.def.name}無法放下`, '#94A3B8', 0.9);
      return;
    }

    this.dropWeapon(weapon, e.x, e.y);
    const fallback = defaultWeaponForHand(e.activeHand);
    e.weapons[e.activeHand] = fallback;
    rt.chargeSessionAllowed = false;
    rt.meleeHeldSeconds = 0;
    e.chargingMelee = false;
    e.chargeReady = false;
    e.swapDuration = getWeaponSwapDuration(fallback.def.kind);
    e.swapTimer = e.swapDuration;
    e.crosshairBloom = 0;
    e.bloomDelayTimer = 0;
    rt.rifleRecoilAngle = 0;
    e.gunfireTimer = 0;
    this.emitNetSfx('switch', e.x, e.y, undefined, false);
    this.spawnText(e.x, e.y - 38, `放下 ${weapon.def.name} · 換回${fallback.def.name}`, '#FBBF24', 1.05);
  }

  private remoteHumanFireGun(e: EnemyEntity, rt: RemoteHumanRuntime, weapon: Extract<EquippedWeapon, { type: 'gun' }>) {
    if (e.attackCooldown > 0 || e.swapTimer > 0 || weapon.reloadTimer > 0 || weapon.ammoInMag <= 0) return;
    const gun = weapon.def;
    const gunProfile = this.siege ? getSiegeGunProfile(gun.kind) : null;
    if (this.siege) {
      const rState = this.siege.remoteStates.get(rt.peerId);
      if (rState) {
        rState.outOfCombatTimer = 0;
        rState.recallTimer = 0;
      }
    }
    const pelletsToFire = gun.kind === 'shotgun' ? Math.max(1, Math.min(gun.pellets, weapon.ammoInMag)) : gun.pellets;
    const ammoCost = gun.kind === 'shotgun' ? pelletsToFire : 1;
    e.attackCooldown = 1 / (gun.fireRate * (gunProfile?.fireRateMult ?? 1));
    rt.lastAttackAt = this.time;
    rt.delayCancelReady = true;
    weapon.ammoInMag = Math.max(0, weapon.ammoInMag - ammoCost);
    if (rt.comboEmpowerTimer > 0) rt.comboEmpowerTimer = 0;

    const aimAngle = e.angle + (gun.kind === 'rifle' ? rt.rifleRecoilAngle * (e.eagleEyeTimer > 0 ? RIFLE_RECOIL.eagleEyeMultiplier : 1) : 0);
    const targetDist = Math.max(GUN_AIM.nearDistance, dist(e.x, e.y, rt.input.aimX, rt.input.aimY));
    const origPellets = gun.kind === 'shotgun' && pelletsToFire < gun.pellets ? pelletsToFire : undefined;
    if (origPellets !== undefined) {
      const saved = weapon.def;
      this.fireEnemyGunHitscan(e, aimAngle, { ...weapon, def: { ...saved, pellets: origPellets } }, targetDist);
    } else {
      this.fireEnemyGunHitscan(e, aimAngle, weapon, targetDist);
    }

    if (gun.kind === 'rifle') {
      rt.rifleRecoilAngle = Math.min(RIFLE_RECOIL.maxAngle, rt.rifleRecoilAngle + RIFLE_RECOIL.kick);
    }
  }

  private updateRemoteHuman(e: EnemyEntity, dt: number) {
    const rt = e.peerId ? this.remoteHumans.get(e.peerId) : undefined;
    if (!rt) return;

    e.attackCooldown = Math.max(0, e.attackCooldown - dt);
    e.gunfireTimer = Math.max(0, e.gunfireTimer - dt);
    e.swapTimer = Math.max(0, e.swapTimer - dt);
    e.attackAnimTimer = Math.max(0, e.attackAnimTimer - dt);
    if (e.attackAnimTimer === 0) e.attackAnimKind = null;
    e.freezeTimer = Math.max(0, e.freezeTimer - dt);
    e.royalShieldTimer = Math.max(0, e.royalShieldTimer - dt);
    e.eagleEyeTimer = Math.max(0, e.eagleEyeTimer - dt);
    e.shadowCloneTimer = Math.max(0, e.shadowCloneTimer - dt);
    e.vampireTimer = Math.max(0, e.vampireTimer - dt);
    e.shrinkTimer = Math.max(0, e.shrinkTimer - dt);
    e.giantTimer = Math.max(0, e.giantTimer - dt);
    e.blindTimer = Math.max(0, e.blindTimer - dt);
    e.stunTimer = Math.max(0, e.stunTimer - dt);
    e.invulnTimer = Math.max(0, (e.invulnTimer ?? 0) - dt);
    e.hitFlash = Math.max(0, e.hitFlash - dt);
    rt.comboEmpowerTimer = Math.max(0, rt.comboEmpowerTimer - dt);
    if (rt.comboTimer > 0) {
      rt.comboTimer -= dt;
      if (rt.comboTimer <= 0) rt.comboCount = 0;
    }

    if (e.freezeTimer > 0) {
      this.clearTimedSkillsOnFreeze(e);
      rt.chargeSessionAllowed = false;
      rt.meleeHeldSeconds = 0;
    }

    e.sizeScale = e.shrinkTimer > 0 ? 0.62 : e.giantTimer > 0 ? 1.32 : 1.0;
    e.radius = e.baseRadius * e.sizeScale;

    const heldWeapon = e.weapons[e.activeHand];
    const isSniper = heldWeapon.type === 'gun' && heldWeapon.def.kind === 'sniper';
    if (isSniper && e.bloomDelayTimer > 0) {
      e.bloomDelayTimer = Math.max(0, e.bloomDelayTimer - dt);
    } else {
      const recoveryRate = isSniper ? SNIPER_AIM.bloomRecovery : GUN_AIM.bloomRecovery;
      e.crosshairBloom = Math.max(0, e.crosshairBloom - recoveryRate * dt);
    }
    rt.rifleRecoilAngle *= Math.exp(-RIFLE_RECOIL.recovery * dt);

    if (heldWeapon.type === 'gun' && heldWeapon.reloadTimer > 0) {
      heldWeapon.reloadTimer = Math.max(0, heldWeapon.reloadTimer - dt);
      if (heldWeapon.reloadTimer === 0) {
        const wholeReserve = Math.floor(rt.reserveAmmo);
        const needed = Math.min(heldWeapon.def.magSize - heldWeapon.ammoInMag, wholeReserve);
        heldWeapon.ammoInMag += needed;
        rt.reserveAmmo = Math.max(0, rt.reserveAmmo - needed);
        this.emitNetSfx('reload', e.x, e.y, heldWeapon.def.kind, true);
      }
    }

    let repMult = getReputationQiMultiplier((rt.startingReputation ?? 0) + rt.reputationChanges[rt.faction]);
    const rSiege = this.siege?.remoteStates.get(rt.peerId);
    if (rSiege) {
      repMult *= 1 + (rSiege.upgrades.core ?? 0) * 0.14 + (rSiege.loadout.passiveId === 'shadow_swift_foot' ? 0.25 : 0);
    }
    if (e.freezeTimer <= 0) {
      if (!rt.chargeSessionAllowed) {
        const rate = rt.qiFastRefund ? 360 : QI_RATE.recover * repMult;
        e.qi = Math.min(e.maxQi, e.qi + rate * dt);
        if (rt.qiFastRefund && e.qi >= e.maxQi - 0.01) {
          e.qi = e.maxQi;
          rt.qiFastRefund = false;
        }
      } else if (!e.chargeReady) {
        rt.qiFastRefund = false;
        let chargeDt = dt;
        if (!e.chargingMelee) {
          rt.meleeHeldSeconds += dt;
          if (rt.meleeHeldSeconds >= MELEE_CHARGE_HOLD_SECONDS && e.swapTimer <= 0) {
            e.chargingMelee = true;
            chargeDt = Math.min(dt, rt.meleeHeldSeconds - MELEE_CHARGE_HOLD_SECONDS);
          } else {
            chargeDt = 0;
          }
        }
        if (chargeDt > 0) {
          e.qi = Math.max(0, e.qi - QI_RATE.charge * repMult * chargeDt);
          if (e.qi === 0 && !e.chargeReady) {
            e.chargeReady = true;
            this.spawnBurst(e.x, e.y, '#FDE047', 16);
          }
        }
      }
    }

    if (e.stunTimer > 0) {
      this.applyIceVentFreezeCheck(e, false);
      rt.chargeSessionAllowed = false;
      e.chargingMelee = false;
      e.chargeReady = false;
      return;
    }

    const inp = rt.input;
    if (inp.swapSeq > rt.lastSwapSeq) {
      rt.lastSwapSeq = inp.swapSeq;
      rt.chargeSessionAllowed = false;
      rt.meleeHeldSeconds = 0;
      e.chargingMelee = false;
      e.chargeReady = false;
      const prev = e.weapons[e.activeHand];
      if (prev.type === 'gun') prev.reloadTimer = 0;
      e.activeHand = e.activeHand === 0 ? 1 : 0;
      e.crosshairBloom = 0;
      e.bloomDelayTimer = 0;
      rt.rifleRecoilAngle = 0;
      const nextW = e.weapons[e.activeHand];
      const baseSwapDur = getWeaponSwapDuration(nextW.def.kind);
      const sinceAttack = this.time - rt.lastAttackAt;
      if (rt.delayCancelReady && sinceAttack <= 0.34 && sinceAttack >= 0.02) {
        e.attackCooldown = 0;
        rt.delayCancelReady = false;
        rt.comboEmpowerTimer = 1.6;
        e.swapDuration = baseSwapDur * 0.45;
        e.swapTimer = e.swapDuration;
      } else {
        e.swapDuration = baseSwapDur;
        e.swapTimer = baseSwapDur;
        e.attackCooldown = Math.max(e.attackCooldown, baseSwapDur);
      }
    }

    if (inp.reloadSeq > rt.lastReloadSeq) {
      rt.lastReloadSeq = inp.reloadSeq;
      const w = e.weapons[e.activeHand];
      if (w.type === 'gun' && w.reloadTimer <= 0 && w.ammoInMag < w.def.magSize && rt.reserveAmmo > 0) {
        let rMult = 1;
        const rSiege = this.siege?.remoteStates.get(rt.peerId);
        if (rSiege) {
          rMult = getSiegeGunProfile(w.def.kind).reloadMult;
          rMult -= (rSiege.upgrades.firepower ?? 0) * 0.06;
          if (rSiege.loadout.passiveId === 'royal_steady_aim') rMult -= 0.15;
          rMult = Math.max(0.45, rMult);
        }
        w.reloadTimer = w.def.reloadTime * rMult;
        this.emitNetSfx('reload', e.x, e.y, w.def.kind, false);
      }
    }

    if (inp.pickupSeq > rt.lastPickupSeq) {
      rt.lastPickupSeq = inp.pickupSeq;
      if (this.mode !== 'siege') this.remoteHumanPickup(e, rt);
    }

    const dropSeq = inp.dropSeq ?? 0;
    if (dropSeq > rt.lastDropSeq) {
      rt.lastDropSeq = dropSeq;
      if (this.mode !== 'siege') this.remoteHumanDropActiveWeapon(e, rt);
    }

    if (this.siege) {
      const rState = this.siege.remoteStates.get(rt.peerId);
      if (rState) {
        if ((inp.tacticalSeq ?? 0) > rt.lastTacticalSeq) {
          rt.lastTacticalSeq = inp.tacticalSeq ?? 0;
          if (
            rState.level >= SIEGE_CONFIG.tacticalUnlockLevel &&
            rState.tacticalCd <= 0 &&
            e.freezeTimer <= 0 &&
            e.stunTimer <= 0
          ) {
            this.castSiegeTacticalSkill(e.id, e, rState.loadout, inp.aimX, inp.aimY);
            rState.tacticalCd = computeSiegeTacticalCooldown(rState);
          }
        }
        if ((inp.ultSeq ?? 0) > rt.lastUltSeq) {
          rt.lastUltSeq = inp.ultSeq ?? 0;
        }
        if ((inp.recallSeq ?? 0) > rt.lastRecallSeq) {
          rt.lastRecallSeq = inp.recallSeq ?? 0;
          if (rState.recallTimer <= 0 && !this.isInsideOwnFountain(e.x, e.y, e.faction === 'shadow' ? 'shadow' : 'royal')) {
            rState.recallTimer = SIEGE_CONFIG.recallDurationSec;
          }
        }
        if ((inp.upgradeSeq ?? 0) > rt.lastUpgradeSeq && inp.upgradeTrack) {
          rt.lastUpgradeSeq = inp.upgradeSeq ?? 0;
          if (this.isInsideOwnFountain(e.x, e.y, e.faction === 'shadow' ? 'shadow' : 'royal')) {
            const res = tryPurchaseSiegeUpgrade(rState, inp.upgradeTrack);
            if (res.ok && inp.upgradeTrack === 'armor') {
              e.maxHp = computeSiegeMaxHp(rState);
              e.hp = Math.min(e.maxHp, e.hp + 32);
            }
          }
        }
      }
    }

    const activeWeapon = e.weapons[e.activeHand];
    const moveLen = Math.hypot(inp.moveX, inp.moveY);
    const mvX = moveLen > 0 ? inp.moveX / Math.max(1, moveLen) : 0;
    const mvY = moveLen > 0 ? inp.moveY / Math.max(1, moveLen) : 0;

    if (Math.abs(mvX) > 0.1 || Math.abs(mvY) > 0.1) {
      this.framePushInputs.push({
        id: e.id,
        isPlayer: false,
        faction: e.faction,
        x: e.x,
        y: e.y,
        radius: e.radius,
        elevation: e.elevation,
        dirX: mvX,
        dirY: mvY,
      });
    }

    const remoteSiegeState = this.siege?.remoteStates.get(rt.peerId);
    const siegeSpeedMult = remoteSiegeState ? computeSiegeMoveSpeedMult(remoteSiegeState) : 1.0;
    const remoteWeaponSpeed =
      this.siege && activeWeapon.type === 'gun'
        ? getSiegeGunProfile(activeWeapon.def.kind).moveSpeedMult
        : activeWeapon.def.moveSpeedMult;
    const moveSpeed =
      PLAYER_MOVEMENT.speed * remoteWeaponSpeed * (e.freezeTimer > 0 ? 0.9 : 1.0) * siegeSpeedMult;
    const prevX = e.x;
    const prevY = e.y;
    const moved = this.moveCharacterWithElevation(e.x, e.y, e.elevation, mvX * moveSpeed * dt, mvY * moveSpeed * dt, e.radius);
    e.x = moved.x;
    e.y = moved.y;
    e.elevation = moved.elevation;
    this.applyIceVentFreezeCheck(e, false);

    const movedDist = dist(prevX, prevY, e.x, e.y);
    e.vx = dt > 0 ? (e.x - prevX) / dt : 0;
    e.vy = dt > 0 ? (e.y - prevY) / dt : 0;
    if (movedDist > 0.12) {
      if (activeWeapon.type === 'gun' && activeWeapon.def.kind === 'sniper') {
        const walkCap = Math.min(activeWeapon.def.maxCrosshair - activeWeapon.def.baseCrosshair, SNIPER_AIM.bodyMoveBloomCap);
        if (e.crosshairBloom <= walkCap) {
          e.crosshairBloom = Math.min(walkCap, e.crosshairBloom + movedDist * SNIPER_AIM.bodyMoveScale);
          e.bloomDelayTimer = Math.max(e.bloomDelayTimer, SNIPER_AIM.settleDelaySeconds);
        }
      }
      e.walkPhase += movedDist * 0.085;
      e.moveIntensity = Math.min(1, e.moveIntensity + dt * 10);
    } else {
      e.moveIntensity = Math.max(0, e.moveIntensity - dt * 10);
    }

    const aimMoveDist = dist(rt.prevAimX, rt.prevAimY, inp.aimX, inp.aimY);
    rt.prevAimX = inp.aimX;
    rt.prevAimY = inp.aimY;
    if (aimMoveDist > 0) {
      const aimGap = this.time - rt.lastAimBloomAt;
      rt.lastAimBloomAt = this.time;
      // Only treat pointer movement as a live flick when aim samples arrive smoothly (not throttled 2s idle syncs)
      if (aimGap > 0 && aimGap <= 0.35 && activeWeapon.type === 'gun') {
        const gun = activeWeapon.def;
        if (gun.kind === 'sniper') {
          const delta = Math.max(0, aimMoveDist - SNIPER_AIM.pointerDeadzonePx) * SNIPER_AIM.pointerMoveScale;
          if (delta > 0) {
            e.crosshairBloom = Math.min(gun.maxCrosshair - gun.baseCrosshair, e.crosshairBloom + Math.min(SNIPER_AIM.pointerMoveStepCap, delta));
            e.bloomDelayTimer = SNIPER_AIM.settleDelaySeconds;
          }
        } else {
          e.crosshairBloom = Math.min(gun.maxCrosshair - gun.baseCrosshair, e.crosshairBloom + Math.min(18, Math.max(0, aimMoveDist - 2) * 0.09));
        }
      }
    }

    if (e.blindTimer > 0) {
      e.angle += dt * 7;
    } else {
      e.angle = Math.atan2(inp.aimY - e.y, inp.aimX - e.x);
    }

    const clicked = inp.clickSeq > rt.lastClickSeq;
    if (clicked) {
      rt.lastClickSeq = inp.clickSeq;
    }
    const released = !inp.mouseDown && rt.wasMouseDown;
    rt.wasMouseDown = inp.mouseDown;

    if (activeWeapon.type === 'gun') {
      rt.chargeSessionAllowed = false;
      e.chargingMelee = false;
      e.chargeReady = false;
      if (clicked && e.swapTimer <= 0 && activeWeapon.ammoInMag <= 0 && activeWeapon.reloadTimer === 0 && rt.reserveAmmo > 0) {
        activeWeapon.reloadTimer = activeWeapon.def.reloadTime;
        this.emitNetSfx('reload', e.x, e.y, activeWeapon.def.kind, false);
      } else if (clicked || (inp.mouseDown && activeWeapon.def.kind === 'rifle')) {
        this.remoteHumanFireGun(e, rt, activeWeapon);
      }
    } else {
      if (clicked) {
        if (e.swapTimer <= 0 && e.attackCooldown <= 0) {
          if (this.siege) {
            const rState = this.siege.remoteStates.get(rt.peerId);
            if (rState) {
              rState.outOfCombatTimer = 0;
              rState.recallTimer = 0;
            }
          }
          const melee = activeWeapon.def;
          const comboMult = rt.comboEmpowerTimer > 0 ? 1 + rt.delayCancelBonus : 1.0;
          e.attackCooldown = 1 / (melee.swingRate * (e.freezeTimer > 0 ? 0.9 : 1));
          rt.lastAttackAt = this.time;
          rt.delayCancelReady = true;
          e.attackAnimDuration = melee.kind === 'greatsword' ? 0.24 : 0.16;
          e.attackAnimTimer = e.attackAnimDuration;
          e.attackAnimKind = melee.kind;
          if (rt.comboEmpowerTimer > 0) rt.comboEmpowerTimer = 0;

          if (melee.kind !== 'shield') {
            this.pushSlash({
              x: e.x,
              y: e.y,
              angle: e.angle,
              arc: melee.arc,
              reach: melee.reach * e.sizeScale,
              color: melee.color,
              life: melee.kind === 'greatsword' ? 0.24 : 0.16,
              maxLife: melee.kind === 'greatsword' ? 0.24 : 0.16,
              isUltimate: false,
              style: melee.kind === 'knife' ? 'thrust' : melee.kind === 'claw' ? 'claw' : 'sweep',
            });
          }
          const mVol = this.nearbySoundVolume(e.x, e.y);
          if (mVol > 0.05) {
            if (melee.kind === 'shield') sfx.shieldBash(mVol * 0.85);
            else sfx.slash(melee.kind, mVol * 0.85);
          }
          this.emitNetSfx('melee', e.x, e.y, melee.kind);
          const dmg = Math.round(melee.damage * comboMult * (e.giantTimer > 0 ? 1.3 : 1.0));
          this.applyRemoteHumanMeleeHitbox(
            e,
            e.x,
            e.y,
            e.elevation,
            e.angle,
            melee.arc,
            melee.reach * e.sizeScale,
            dmg,
            melee.kind === 'shield'
          );
        }
        if (inp.mouseDown) {
          const remoteSiege = this.siege?.remoteStates.get(rt.peerId);
          const ultAllowed =
            this.mode !== 'siege' ||
            activeWeapon.def.kind === 'shield' ||
            (remoteSiege?.level ?? 1) >= SIEGE_CONFIG.ultimateUnlockLevel;
          rt.chargeSessionAllowed = ultAllowed && e.freezeTimer <= 0 && e.qi >= e.maxQi - 0.5;
        }
      }
      if (released) {
        let firedUlt = false;
        if (e.chargeReady && e.freezeTimer <= 0) {
          firedUlt = true;
          e.chargeReady = false;
          e.attackCooldown = 0.25;
          rt.lastAttackAt = this.time;
          rt.delayCancelReady = true;
          e.attackAnimDuration = activeWeapon.def.kind === 'greatsword' ? 0.26 : 0.16;
          e.attackAnimTimer = e.attackAnimDuration;
          e.attackAnimKind = activeWeapon.def.kind;
          this.emitNetSfx('skill', e.x, e.y);
          this.executeEnemyFactionSkill(e, activeWeapon, e.angle);
        } else if (!firedUlt && e.chargingMelee && !e.chargeReady && e.freezeTimer <= 0) {
          rt.qiFastRefund = true;
        }
        rt.chargeSessionAllowed = false;
        rt.meleeHeldSeconds = 0;
        e.chargingMelee = false;
        e.chargeReady = false;
      }
    }
  }

  public getLocalInputSnapshot(seqs: {
    clickSeq: number;
    reloadSeq: number;
    swapSeq: number;
    pickupSeq: number;
    dropSeq: number;
    tacticalSeq?: number;
    ultSeq?: number;
    recallSeq?: number;
    upgradeSeq?: number;
    upgradeTrack?: SiegeUpgradeTrack;
  }): RemotePlayerInput {
    const mv = this.getMoveVector();
    const ptr = this.getWorldPointer();
    return {
      moveX: mv.x === 0 ? 0 : Math.sign(mv.x),
      moveY: mv.y === 0 ? 0 : Math.sign(mv.y),
      aimX: round1(ptr.x),
      aimY: round1(ptr.y),
      mouseDown: this.mouseDown,
      clickSeq: seqs.clickSeq,
      reloadSeq: seqs.reloadSeq,
      swapSeq: seqs.swapSeq,
      pickupSeq: seqs.pickupSeq,
      dropSeq: seqs.dropSeq,
      ...(seqs.tacticalSeq ? { tacticalSeq: seqs.tacticalSeq } : {}),
      ...(seqs.ultSeq ? { ultSeq: seqs.ultSeq } : {}),
      ...(seqs.recallSeq ? { recallSeq: seqs.recallSeq } : {}),
      ...(seqs.upgradeSeq ? { upgradeSeq: seqs.upgradeSeq, upgradeTrack: seqs.upgradeTrack } : {}),
    };
  }

  public getClientSyncHints(): { hasNearbyCombatant: boolean; holdingShield: boolean } {
    const p = this.player;
    const nearbyRadiusSq = (6.5 * TILE) ** 2;
    let hasNearbyCombatant = false;
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      if (dx * dx + dy * dy <= nearbyRadiusSq) {
        hasNearbyCombatant = true;
        break;
      }
    }
    const active = p.weapons[p.activeHand];
    const holdingShield = active.type === 'melee' && active.def.kind === 'shield';
    return { hasNearbyCombatant, holdingShield };
  }

  public getRecommendedSnapshotIntervalMs(): { intervalMs: number; hasEvents: boolean } {
    const hasEvents = this.netEvents.length > 0;
    if (hasEvents) {
      return { intervalMs: 50, hasEvents: true };
    }
    if (this.projectiles.length > 0) {
      return { intervalMs: 60, hasEvents: false };
    }
    const livingHumans: { x: number; y: number }[] = [];
    if (this.player.hp > 0) {
      livingHumans.push({ x: this.player.x, y: this.player.y });
    }
    for (const e of this.enemies) {
      if (e.hp > 0 && e.isHumanPlayer) {
        livingHumans.push({ x: e.x, y: e.y });
      }
    }
    const humanProximitySq = (9 * TILE) ** 2;
    const combatProximitySq = (7 * TILE) ** 2;
    for (let i = 0; i < livingHumans.length; i++) {
      for (let j = i + 1; j < livingHumans.length; j++) {
        const dx = livingHumans[i].x - livingHumans[j].x;
        const dy = livingHumans[i].y - livingHumans[j].y;
        if (dx * dx + dy * dy <= humanProximitySq) {
          return { intervalMs: 60, hasEvents: false };
        }
      }
    }
    for (const e of this.enemies) {
      if (e.hp <= 0 || !e.isHumanPlayer) continue;
      for (const other of this.enemies) {
        if (other === e || other.hp <= 0) continue;
        const dx = e.x - other.x;
        const dy = e.y - other.y;
        if (dx * dx + dy * dy <= combatProximitySq) {
          return { intervalMs: 60, hasEvents: false };
        }
      }
    }
    return { intervalMs: 100, hasEvents: false };
  }

  public exportWorldSnapshot(): NetWorldSnapshot {
    const p = this.player;
    const hostPeerId = this.multiplayer?.hostPeerId ?? 'host';
    const hostDesc = this.multiplayer?.peers.find((pr) => pr.peerId === hostPeerId);
    const actors: NetActorSnapshot[] = [
      {
        id: 'player',
        peerId: hostPeerId,
        isHuman: true,
        name: hostDesc?.name ?? p.characterSkin.name,
        faction: p.faction,
        skinId: p.characterSkin.id,
        x: round1(p.x),
        y: round1(p.y),
        ...(Math.abs(p.vx) > 0.5 ? { vx: round1(p.vx) } : {}),
        ...(Math.abs(p.vy) > 0.5 ? { vy: round1(p.vy) } : {}),
        angle: Number(p.angle.toFixed(3)),
        elev: p.elevation,
        hp: Math.round(p.hp),
        ...(p.maxHp !== 100 ? { maxHp: Math.round(p.maxHp) } : {}),
        qi: Math.round(p.qi),
        lives: p.lives,
        ...(this.respawnTimer > 0 ? { respawn: round1(this.respawnTimer) } : {}),
        score: Math.floor(p.score),
        dmg: p.totalDamage,
        kills: p.kills,
        ...(p.comboCount > 0 ? { combo: p.comboCount } : {}),
        maxCombo: p.maxCombo,
        reserve: Math.floor(p.reserveAmmo),
        hand: p.activeHand,
        slots: [this.serializeWeaponSlot(p.weapons[0]), this.serializeWeaponSlot(p.weapons[1])],
        ...(p.swapTimer > 0 ? { swap: round1(p.swapTimer), swapDur: round1(p.swapDuration) } : {}),
        ...(p.gunfireTimer > 0 ? { gunfire: round1(p.gunfireTimer) } : {}),
        ...(p.attackAnimTimer > 0
          ? {
              atkAnim: round1(p.attackAnimTimer),
              atkDur: round1(p.attackAnimDuration),
              ...(p.attackAnimKind ? { atkKind: p.attackAnimKind } : {}),
            }
          : {}),
        ...(p.chargingMelee && this.chargeSessionAllowed ? { charging: true } : {}),
        ...(p.chargeReady ? { chargeReady: true } : {}),
        ...(p.comboEmpowerTimer > 0 ? { comboEmp: true } : {}),
        ...(p.royalShieldTimer > 0 ? { shield: round1(p.royalShieldTimer) } : {}),
        ...(p.royalShieldImpact ? { shieldImp: p.royalShieldImpact } : {}),
        ...(p.eagleEyeTimer > 0 ? { eagle: round1(p.eagleEyeTimer) } : {}),
        ...(p.shadowCloneTimer > 0 ? { shadow: round1(p.shadowCloneTimer) } : {}),
        ...(p.vampireTimer > 0 ? { vamp: round1(p.vampireTimer) } : {}),
        ...(p.shrinkTimer > 0 ? { shrink: round1(p.shrinkTimer) } : {}),
        ...(p.giantTimer > 0 ? { giant: round1(p.giantTimer) } : {}),
        ...(p.blindTimer > 0 ? { blind: round1(p.blindTimer), blindDur: round1(p.blindDuration) } : {}),
        ...(p.freezeTimer > 0 ? { freeze: round1(p.freezeTimer) } : {}),
        ...(p.invulnTimer > 0 ? { invuln: round1(p.invulnTimer) } : {}),
        ...(this.crosshairBloom > 0.05 ? { bloom: round1(this.crosshairBloom) } : {}),
      },
    ];

    const liveRemotePeerIds = new Set<string>();
    for (const e of this.enemies) {
      const rt = e.peerId ? this.remoteHumans.get(e.peerId) : undefined;
      if (rt && e.peerId) liveRemotePeerIds.add(e.peerId);
      actors.push({
        id: e.id,
        ...(e.peerId ? { peerId: e.peerId } : {}),
        isHuman: Boolean(rt) || Boolean(e.isHumanPlayer),
        name: e.name,
        faction: e.faction,
        skinId: e.characterSkin.id,
        archetype: e.archetype,
        x: round1(e.x),
        y: round1(e.y),
        ...(Math.abs(e.vx) > 0.5 ? { vx: round1(e.vx) } : {}),
        ...(Math.abs(e.vy) > 0.5 ? { vy: round1(e.vy) } : {}),
        angle: Number(e.angle.toFixed(3)),
        elev: e.elevation,
        hp: Math.round(e.hp),
        ...(e.maxHp !== 100 ? { maxHp: Math.round(e.maxHp) } : {}),
        qi: Math.round(e.qi),
        ...(rt
          ? {
              lives: rt.lives,
              ...(rt.respawnTimer > 0 ? { respawn: round1(rt.respawnTimer) } : {}),
              score: Math.floor(rt.score),
              dmg: rt.totalDamage,
              kills: rt.kills,
              reputationChanges: { ...rt.reputationChanges },
              ...(rt.comboCount > 0 ? { combo: rt.comboCount } : {}),
              maxCombo: rt.maxCombo,
              reserve: Math.floor(rt.reserveAmmo),
              ...(rt.comboEmpowerTimer > 0 ? { comboEmp: true } : {}),
            }
          : {}),
        hand: e.activeHand,
        slots: [this.serializeWeaponSlot(e.weapons[0]), this.serializeWeaponSlot(e.weapons[1])],
        ...(e.swapTimer > 0 ? { swap: round1(e.swapTimer), swapDur: round1(e.swapDuration) } : {}),
        ...(e.gunfireTimer > 0 ? { gunfire: round1(e.gunfireTimer) } : {}),
        ...(e.attackAnimTimer > 0
          ? {
              atkAnim: round1(e.attackAnimTimer),
              atkDur: round1(e.attackAnimDuration),
              ...(e.attackAnimKind ? { atkKind: e.attackAnimKind } : {}),
            }
          : {}),
        ...(e.chargingMelee ? { charging: true } : {}),
        ...(e.chargeReady ? { chargeReady: true } : {}),
        ...(e.royalShieldTimer > 0 ? { shield: round1(e.royalShieldTimer) } : {}),
        ...(e.royalShieldImpact ? { shieldImp: e.royalShieldImpact } : {}),
        ...(e.eagleEyeTimer > 0 ? { eagle: round1(e.eagleEyeTimer) } : {}),
        ...(e.shadowCloneTimer > 0 ? { shadow: round1(e.shadowCloneTimer) } : {}),
        ...(e.vampireTimer > 0 ? { vamp: round1(e.vampireTimer) } : {}),
        ...(e.shrinkTimer > 0 ? { shrink: round1(e.shrinkTimer) } : {}),
        ...(e.giantTimer > 0 ? { giant: round1(e.giantTimer) } : {}),
        ...(e.blindTimer > 0 ? { blind: round1(e.blindTimer) } : {}),
        ...(e.freezeTimer > 0 ? { freeze: round1(e.freezeTimer) } : {}),
        ...(e.stunTimer > 0 ? { stun: round1(e.stunTimer) } : {}),
        ...((e.invulnTimer ?? 0) > 0 ? { invuln: round1(e.invulnTimer ?? 0) } : {}),
        ...(e.hitFlash > 0 ? { hitFlash: round1(e.hitFlash) } : {}),
        ...(e.crosshairBloom > 0.05 ? { bloom: round1(e.crosshairBloom) } : {}),
      });
    }

    for (const rt of this.remoteHumans.values()) {
      if (liveRemotePeerIds.has(rt.peerId)) continue;
      actors.push({
        id: rt.entityId,
        peerId: rt.peerId,
        isHuman: true,
        name: rt.name,
        faction: rt.faction,
        skinId: rt.characterSkin.id,
        x: round1(rt.prevAimX),
        y: round1(rt.prevAimY),
        angle: 0,
        elev: 0,
        hp: 0,
        qi: 0,
        lives: rt.lives,
        ...(rt.respawnTimer > 0 ? { respawn: round1(rt.respawnTimer) } : {}),
        score: Math.floor(rt.score),
        dmg: rt.totalDamage,
        kills: rt.kills,
        reputationChanges: { ...rt.reputationChanges },
        ...(rt.comboCount > 0 ? { combo: rt.comboCount } : {}),
        maxCombo: rt.maxCombo,
        reserve: Math.floor(rt.reserveAmmo),
        hand: 0,
        slots: [this.serializeWeaponSlot(defaultWeaponForHand(0)), this.serializeWeaponSlot(defaultWeaponForHand(1))],
      });
    }

    const events = this.netEvents;
    this.netEvents = [];
    const nextSeq = ++this.snapshotSeq;
    const isKeyframe = this.forceNextKeyframe || nextSeq === 1 || nextSeq % 25 === 0;
    this.forceNextKeyframe = false;

    const pickupsSig = this.pickups
      .map((pk) => `${pk.id}:${Math.round(pk.x)},${Math.round(pk.y)},${pk.ammoInMag ?? ''},${pk.durability ?? ''}`)
      .join('|');
    const includePickups = isKeyframe || pickupsSig !== this.lastExportedPickupsSig;
    if (includePickups) {
      this.lastExportedPickupsSig = pickupsSig;
    }

    const iceList = this.map.pushableIceBlocks || [];
    let includeIceBlocks = false;
    if (iceList.length > 0) {
      const iceSig = iceList
        .map((blk) => `${blk.id}:${Math.round(blk.x)},${Math.round(blk.y)},${blk.slideDir ?? ''}`)
        .join('|');
      includeIceBlocks = isKeyframe || iceSig !== this.lastExportedIceSig;
      if (includeIceBlocks) {
        this.lastExportedIceSig = iceSig;
      }
    }

    return {
      seq: nextSeq,
      t: round1(this.time),
      status: this.status,
      banner: this.bannerTimer > 0 ? this.bannerText : '',
      skillBanner: this.activeSkillBannerTimer > 0 ? this.activeSkillBanner : null,
      factionScores: { ...this.factionScores },
      deploymentQueue: { ...this.deploymentQueue },
      actors,
      ...(includePickups
        ? {
            pickups: this.pickups.map((pk) => ({
              id: pk.id,
              x: round1(pk.x),
              y: round1(pk.y),
              kind: pk.kind,
              ...(pk.gunDef ? { itemId: pk.gunDef.id } : pk.meleeDef ? { itemId: pk.meleeDef.id } : {}),
              ...(pk.ammoInMag !== undefined ? { ammo: pk.ammoInMag } : {}),
              ...(pk.durability !== undefined ? { dur: Math.round(pk.durability) } : {}),
            })),
          }
        : {}),
      projectiles: this.projectiles.map((pr) => ({
        id: pr.id,
        x: round1(pr.x),
        y: round1(pr.y),
        vx: round1(pr.vx),
        vy: round1(pr.vy),
        r: pr.radius,
        color: pr.color,
        ownerId: pr.ownerId,
        ownerFaction: pr.ownerFaction,
        ...(pr.isWave ? { isWave: true } : {}),
        ...(pr.isLightOrb ? { isLightOrb: true } : {}),
        ...(pr.healAllies ? { healAllies: true } : {}),
        ...(pr.isBlackDragon ? { isBlackDragon: true } : {}),
        ...(pr.segments ? { segs: pr.segments.map((s) => ({ x: round1(s.x), y: round1(s.y) })) } : {}),
      })),
      ...(includeIceBlocks
        ? {
            iceBlocks: iceList.map((blk) => ({
              id: blk.id,
              x: round1(blk.x),
              y: round1(blk.y),
              baseElev: blk.baseElev,
              elev: blk.elevation,
              slideTimer: round1(blk.slideTimer),
              slideDir: blk.slideDir,
            })),
          }
        : {}),
      ...(this.siege ? { siege: this.exportSiegeSnapshot() } : {}),
      events,
    };
  }

  public applyWorldSnapshot(snapshot: NetWorldSnapshot) {
    const localPeerId = this.multiplayer?.localPeerId;
    const localActor = localPeerId ? snapshot.actors.find((a) => a.peerId === localPeerId) : snapshot.actors[0];
    if (!localActor) return;

    const p = this.player;
    const prevStatus = this.status;
    const prevHp = p.hp;
    const prevPlayerSnap = this.clientLerpTargets.get('__local__');
    if (!prevPlayerSnap || dist(p.x, p.y, localActor.x, localActor.y) > 160) {
      p.x = localActor.x;
      p.y = localActor.y;
    }
    this.clientLerpTargets.set('__local__', {
      x: localActor.x,
      y: localActor.y,
      vx: localActor.vx ?? 0,
      vy: localActor.vy ?? 0,
      angle: localActor.angle,
      elev: localActor.elev,
      extrapTime: 0,
    });
    p.vx = localActor.vx ?? 0;
    p.vy = localActor.vy ?? 0;
    p.elevation = localActor.elev;
    p.hp = localActor.hp;
    if (localActor.maxHp !== undefined) {
      p.maxHp = localActor.maxHp;
    }
    p.qi = localActor.qi;
    p.lives = localActor.lives ?? p.lives;
    p.score = localActor.score ?? p.score;
    p.totalDamage = localActor.dmg ?? p.totalDamage;
    p.kills = localActor.kills ?? p.kills;
    p.comboCount = localActor.combo ?? 0;
    p.maxCombo = localActor.maxCombo ?? p.maxCombo;
    p.reserveAmmo = localActor.reserve ?? p.reserveAmmo;
    p.faction = localActor.faction;
    // Snapshots carry match totals so skipping a frame cannot drop a reputation change.
    const changes = localActor.reputationChanges;
    if (changes && snapshot.seq > this.lastReputationSnapshotSeq &&
        Number.isSafeInteger(changes.royal) && Number.isSafeInteger(changes.shadow) &&
        Number.isSafeInteger(changes.mercenary)) {
      const previous = this.appliedReputationChanges;
      this.lastReputationSnapshotSeq = snapshot.seq;
      this.appliedReputationChanges = { ...changes };
      this.applyLocalReputationChange({
        royal: changes.royal - previous.royal,
        shadow: changes.shadow - previous.shadow,
        mercenary: changes.mercenary - previous.mercenary,
      });
    }
    p.characterSkin = this.resolveSkinById(localActor.skinId, localActor.faction);
    p.activeHand = localActor.hand;
    p.weapons = [
      this.deserializeWeaponSlot(localActor.slots[0]),
      this.deserializeWeaponSlot(localActor.slots[1]),
    ];
    p.swapTimer = localActor.swap ?? 0;
    p.swapDuration = localActor.swapDur ?? 0;
    p.gunfireTimer = localActor.gunfire ?? 0;
    p.attackAnimTimer = localActor.atkAnim ?? 0;
    p.attackAnimDuration = localActor.atkDur ?? 0;
    p.attackAnimKind = localActor.atkKind ?? null;
    const prevChargeReady = p.chargeReady;
    p.chargingMelee = Boolean(localActor.charging);
    this.chargeSessionAllowed = p.chargingMelee;
    p.chargeReady = Boolean(localActor.chargeReady);
    if (!prevChargeReady && p.chargeReady) {
      sfx.meleeReady();
    }
    p.comboEmpowerTimer = localActor.comboEmp ? 1.0 : 0;
    p.royalShieldTimer = localActor.shield ?? 0;
    p.royalShieldImpact = localActor.shieldImp;
    p.eagleEyeTimer = localActor.eagle ?? 0;
    p.shadowCloneTimer = localActor.shadow ?? 0;
    p.vampireTimer = localActor.vamp ?? 0;
    p.shrinkTimer = localActor.shrink ?? 0;
    p.giantTimer = localActor.giant ?? 0;
    p.blindTimer = localActor.blind ?? 0;
    p.blindDuration = localActor.blindDur ?? 0;
    p.freezeTimer = localActor.freeze ?? 0;
    p.invulnTimer = localActor.invuln ?? 0;
    p.sizeScale = p.shrinkTimer > 0 ? 0.62 : p.giantTimer > 0 ? 1.32 : 1.0;
    p.radius = p.baseRadius * p.sizeScale;
    this.crosshairBloom = localActor.bloom ?? 0;
    this.respawnTimer = localActor.respawn ?? 0;

    const existingMap = new Map(this.enemies.map((e) => [e.id, e]));
    const nextEnemies: EnemyEntity[] = [];
    for (const actor of snapshot.actors) {
      if (actor === localActor || actor.hp <= 0) continue;
      const skin = this.resolveSkinById(actor.skinId, actor.faction);
      let ent = existingMap.get(actor.id);
      if (!ent) {
        ent = {
          id: actor.id,
          isHumanPlayer: actor.isHuman,
          peerId: actor.peerId,
          name: actor.name,
          archetype: actor.archetype ?? 'trooper',
          faction: actor.faction,
          isAlly: !areHostile(p.faction, localActor.id, actor.faction, actor.id),
          activeHand: actor.hand,
          weapons: [this.deserializeWeaponSlot(actor.slots[0]), this.deserializeWeaponSlot(actor.slots[1])],
          swapTimer: actor.swap ?? 0,
          swapDuration: actor.swapDur ?? 0,
          x: actor.x,
          y: actor.y,
          vx: actor.vx ?? 0,
          vy: actor.vy ?? 0,
          baseRadius: CHAR_BASE_RADIUS,
          radius: CHAR_BASE_RADIUS,
          sizeScale: 1,
          angle: actor.angle,
          walkPhase: 0,
          moveIntensity: 0,
          elevation: actor.elev,
          hp: actor.hp,
          maxHp: actor.maxHp ?? 100,
          qi: actor.qi,
          maxQi: 100,
          chargingMelee: Boolean(actor.charging),
          chargeReady: Boolean(actor.chargeReady),
          speed: 150,
          attackCooldown: 0,
          aiTimer: 0,
          lastSeenTargetPos: null,
          alertTimer: 0,
          hasLosToTarget: false,
          visibleTargetId: null,
          reactionTimer: 0,
          focusedTargetId: null,
          aggroLockTimer: 0,
          pathTiles: [],
          pathTimer: 0,
          patrolAnchor: { x: actor.x, y: actor.y },
          patrolTarget: null,
          patrolTimer: 0,
          royalShieldTimer: actor.shield ?? 0,
          royalShieldImpact: actor.shieldImp,
          eagleEyeTimer: actor.eagle ?? 0,
          shadowCloneTimer: actor.shadow ?? 0,
          vampireTimer: actor.vamp ?? 0,
          shrinkTimer: actor.shrink ?? 0,
          giantTimer: actor.giant ?? 0,
          blindTimer: actor.blind ?? 0,
          stunTimer: actor.stun ?? 0,
          freezeTimer: actor.freeze ?? 0,
          invulnTimer: actor.invuln ?? 0,
          hitFlash: actor.hitFlash ?? 0,
          gunfireTimer: actor.gunfire ?? 0,
          crosshairBloom: actor.bloom ?? 0,
          bloomDelayTimer: 0,
          lastAimAngle: actor.angle,
          attackAnimTimer: actor.atkAnim ?? 0,
          attackAnimDuration: actor.atkDur ?? 0,
          attackAnimKind: actor.atkKind ?? null,
          color: FACTIONS[actor.faction].accentHex,
          characterSkin: skin,
        };
      } else {
        if (dist(ent.x, ent.y, actor.x, actor.y) > 160) {
          ent.x = actor.x;
          ent.y = actor.y;
        }
        ent.isHumanPlayer = actor.isHuman;
        ent.peerId = actor.peerId;
        ent.name = actor.name;
        ent.faction = actor.faction;
        ent.characterSkin = skin;
        ent.color = FACTIONS[actor.faction].accentHex;
        ent.isAlly = !areHostile(p.faction, localActor.id, actor.faction, actor.id);
        ent.activeHand = actor.hand;
        ent.weapons = [this.deserializeWeaponSlot(actor.slots[0]), this.deserializeWeaponSlot(actor.slots[1])];
        ent.swapTimer = actor.swap ?? 0;
        ent.swapDuration = actor.swapDur ?? 0;
        ent.hp = actor.hp;
        ent.qi = actor.qi;
        ent.elevation = actor.elev;
        ent.chargingMelee = Boolean(actor.charging);
        ent.chargeReady = Boolean(actor.chargeReady);
        if (actor.maxHp !== undefined) {
          ent.maxHp = actor.maxHp;
        }
        ent.royalShieldTimer = actor.shield ?? 0;
        ent.royalShieldImpact = actor.shieldImp;
        ent.eagleEyeTimer = actor.eagle ?? 0;
        ent.shadowCloneTimer = actor.shadow ?? 0;
        ent.vampireTimer = actor.vamp ?? 0;
        ent.shrinkTimer = actor.shrink ?? 0;
        ent.giantTimer = actor.giant ?? 0;
        ent.blindTimer = actor.blind ?? 0;
        ent.stunTimer = actor.stun ?? 0;
        ent.freezeTimer = actor.freeze ?? 0;
        ent.invulnTimer = actor.invuln ?? 0;
        ent.hitFlash = actor.hitFlash ?? 0;
        ent.gunfireTimer = actor.gunfire ?? 0;
        ent.attackAnimTimer = actor.atkAnim ?? 0;
        ent.attackAnimDuration = actor.atkDur ?? 0;
        ent.attackAnimKind = actor.atkKind ?? null;
      }
      ent.sizeScale = ent.shrinkTimer > 0 ? 0.62 : ent.giantTimer > 0 ? 1.32 : 1.0;
      ent.radius = ent.baseRadius * ent.sizeScale;
      this.clientLerpTargets.set(ent.id, {
        x: actor.x,
        y: actor.y,
        vx: actor.vx ?? 0,
        vy: actor.vy ?? 0,
        angle: actor.angle,
        elev: actor.elev,
        extrapTime: 0,
      });
      nextEnemies.push(ent);
    }
    this.enemies = nextEnemies;

    if (snapshot.pickups !== undefined) {
      this.pickups = snapshot.pickups.map((pk) => {
        if (pk.kind === 'gun' && pk.itemId) {
          const gunDef = ALL_GUNS_BY_ID.get(pk.itemId) || DEFAULT_PISTOL;
          return {
            id: pk.id,
            x: pk.x,
            y: pk.y,
            kind: 'gun',
            label: gunDef.name,
            color: gunDef.color,
            gunDef,
            ammoInMag: pk.ammo ?? gunDef.magSize,
            bobPhase: this.time * 4,
          };
        }
        if (pk.kind === 'melee' && pk.itemId) {
          const meleeDef = ALL_MELEES_BY_ID.get(pk.itemId) || DEFAULT_KNIFE;
          return {
            id: pk.id,
            x: pk.x,
            y: pk.y,
            kind: 'melee',
            label: meleeDef.name,
            color: meleeDef.color,
            meleeDef,
            ...(pk.dur !== undefined ? { durability: pk.dur } : {}),
            bobPhase: this.time * 4,
          };
        }
        return {
          id: pk.id,
          x: pk.x,
          y: pk.y,
          kind: 'ammo',
          label: '彈藥箱 (+30發)',
          color: '#60A5FA',
          amount: 30,
          bobPhase: this.time * 4,
        };
      });
    }

    this.projectiles = snapshot.projectiles.map((pr) => ({
      id: pr.id,
      x: pr.x,
      y: pr.y,
      prevX: pr.x,
      prevY: pr.y,
      vx: pr.vx,
      vy: pr.vy,
      radius: pr.r,
      damage: 0,
      startElevation: 0,
      minTraversedElevation: 0,
      ownerId: pr.ownerId,
      ownerFaction: pr.ownerFaction,
      fromPlayer: pr.ownerId === localActor.id,
      isAlly: !areHostile(p.faction, localActor.id, pr.ownerFaction, pr.ownerId),
      color: pr.color,
      life: 1,
      maxLife: 1,
      pierce: 0,
      isWave: pr.isWave,
      isLightOrb: pr.isLightOrb,
      healAllies: pr.healAllies,
      isBlackDragon: pr.isBlackDragon,
      segments: pr.segs,
      hitIds: new Set<string>(),
    }));

    if (this.map.pushableIceBlocks && snapshot.iceBlocks && snapshot.iceBlocks.length > 0) {
      const byId = new Map(snapshot.iceBlocks.map((b) => [b.id, b]));
      for (const blk of this.map.pushableIceBlocks) {
        const snapBlk = byId.get(blk.id);
        if (!snapBlk) continue;
        blk.x = snapBlk.x;
        blk.y = snapBlk.y;
        blk.baseElev = snapBlk.baseElev;
        blk.elevation = snapBlk.elev;
        blk.slideTimer = snapBlk.slideTimer;
        blk.slideDir = snapBlk.slideDir;
      }
    }

    this.factionScores = { ...snapshot.factionScores };
    this.deploymentQueue = { ...snapshot.deploymentQueue };
    this.bannerText = snapshot.banner;
    this.bannerTimer = snapshot.banner ? 0.5 : 0;
    this.activeSkillBanner = snapshot.skillBanner ?? '';
    this.activeSkillBannerTimer = snapshot.skillBanner ? 0.5 : 0;

    if (snapshot.siege && this.siege) {
      this.applySiegeSnapshot(snapshot.siege, localPeerId);
    }

    if (snapshot.status === 'VICTORY' || snapshot.status === 'GAME_OVER') {
      const clientWon = this.siege
        ? this.siege.structures.find((s) => s.faction !== (localActor.faction === 'shadow' ? 'shadow' : 'royal') && s.kind === 'castle')?.alive === false ||
          ((this.siege.structures.find((s) => s.faction === (localActor.faction === 'shadow' ? 'shadow' : 'royal') && s.kind === 'castle')?.hp ?? 0) >
            (this.siege.structures.find((s) => s.faction !== (localActor.faction === 'shadow' ? 'shadow' : 'royal') && s.kind === 'castle')?.hp ?? 0))
        : localActor.hp > 0 ||
          (localActor.faction !== 'mercenary' &&
            snapshot.actors.some(
              (a) => a.faction === localActor.faction && (a.hp > 0 || (a.lives ?? 0) > 0)
            ));
      const nextStatus = clientWon ? 'VICTORY' : 'GAME_OVER';
      if (this.status !== nextStatus) {
        if (nextStatus === 'VICTORY') sfx.victory();
        else sfx.defeat();
        this.clearInputs();
      }
      this.status = nextStatus;
    } else if (localActor.hp <= 0 && (localActor.lives ?? 0) > 0) {
      this.status = 'RESPAWNING';
    } else {
      this.status = snapshot.status === 'PAUSED' ? 'PAUSED' : 'PLAYING';
    }
    if (this.hasEmittedClientHud && prevHp > 0 && p.hp <= 0) {
      sfx.playerDown();
    }

    for (const ev of snapshot.events) {
      if (ev.k === 'beam') {
        this.beams.push({ x1: ev.x1, y1: ev.y1, x2: ev.x2, y2: ev.y2, color: ev.color, life: ev.life, maxLife: ev.life, width: ev.w });
      } else if (ev.k === 'slash') {
        this.slashes.push({ x: ev.x, y: ev.y, angle: ev.angle, arc: ev.arc, reach: ev.reach, color: ev.color, life: ev.life, maxLife: ev.life, isUltimate: ev.ult, style: ev.style });
      } else if (ev.k === 'text') {
        this.floatingTexts.push({ x: ev.x, y: ev.y, vy: -38, text: ev.text, color: ev.color, life: 0.85, maxLife: 0.85, scale: ev.scale, subtle: ev.subtle });
      } else if (ev.k === 'burst') {
        for (let i = 0; i < ev.count; i++) {
          const a = Math.random() * Math.PI * 2;
          const spd = 60 + Math.random() * 200;
          this.particles.push({ x: ev.x, y: ev.y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, size: 2 + Math.random() * 3.5, color: ev.color, life: 0.25 + Math.random() * 0.25, maxLife: 0.5 });
        }
      } else if (ev.k === 'trace') {
        this.skillTraces.push({ kind: ev.kind, fromX: ev.fx, fromY: ev.fy, destination: { x: ev.tx, y: ev.ty }, startedAt: this.time, duration: ev.dur });
      } else if (ev.k === 'sfx') {
        const vol = this.nearbySoundVolume(ev.x, ev.y);
        if (ev.kind === 'gun') sfx.gunshot((ev.sub as GunDef['kind']) || 'pistol', Math.max(0.15, vol * 0.6));
        else if (ev.kind === 'melee') {
          const mVol = Math.max(0.25, vol * 0.85);
          if (ev.sub === 'shield') sfx.shieldBash(mVol);
          else sfx.slash((ev.sub as MeleeKind) || 'knife', mVol);
        }
        else if (ev.kind === 'hit') sfx.hit(Boolean(ev.flag));
        else if (ev.kind === 'down') sfx.soldierDown(vol * 0.75);
        else if (ev.kind === 'skill') sfx.ultimate();
        else if (ev.kind === 'reload') sfx.reload((ev.sub as GunDef['kind']) || 'pistol', ev.flag === false ? 'start' : 'ready');
        else if (ev.kind === 'switch') sfx.switchWeapon(Boolean(ev.flag));
      }
    }

    if (!this.hasEmittedClientHud || prevStatus !== this.status) {
      this.hasEmittedClientHud = true;
      this.emitHud();
    }
  }

  private updateClientView(dt: number, canvasWidth: number, canvasHeight: number) {
    this.time += dt;
    if (this.skillTraces.length > 0) {
      this.skillTraces = this.skillTraces.filter((trace) => this.time - trace.startedAt < trace.duration);
    }
    this.beams = this.beams.filter((b) => {
      b.life -= dt;
      return b.life > 0;
    });
    this.slashes = this.slashes.filter((s) => {
      s.life -= dt;
      return s.life > 0;
    });
    this.particles = this.particles.filter((pt) => {
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vx *= 0.92;
      pt.vy *= 0.92;
      pt.life -= dt;
      return pt.life > 0;
    });
    this.floatingTexts = this.floatingTexts.filter((ft) => {
      ft.y += ft.vy * dt;
      ft.life -= dt;
      return ft.life > 0;
    });
    for (const pk of this.pickups) pk.bobPhase += dt * 4;
    if (this.camera.shake > 0) this.camera.shake = Math.max(0, this.camera.shake - dt * 26);

    const p = this.player;
    this.camera.zoom = this.getBaseZoom(canvasWidth, canvasHeight);

    const pTarget = this.clientLerpTargets.get('__local__');
    if (p.hp > 0) {
      const prevX = p.x;
      const prevY = p.y;
      const mv = this.getMoveVector();
      const isMoving = Math.hypot(mv.x, mv.y) > 0.05;
      if (this.status === 'PLAYING' && isMoving) {
        const weaponSpeedMult = p.weapons[p.activeHand].def.moveSpeedMult;
        const freezeSpeedMult = p.freezeTimer > 0 ? 0.9 : 1.0;
        const speed = PLAYER_MOVEMENT.speed * weaponSpeedMult * freezeSpeedMult;
        const pred = this.moveCharacterWithElevation(p.x, p.y, p.elevation, mv.x * speed * dt, mv.y * speed * dt, p.radius);
        p.x = pred.x;
        p.y = pred.y;
        p.elevation = pred.elevation;
      }

      if (pTarget) {
        if (pTarget.extrapTime < 0.06 && (pTarget.vx !== 0 || pTarget.vy !== 0)) {
          const step = Math.min(dt, 0.06 - pTarget.extrapTime);
          pTarget.extrapTime += step;
          const ex = this.moveCharacterWithElevation(
            pTarget.x,
            pTarget.y,
            pTarget.elev,
            pTarget.vx * step,
            pTarget.vy * step,
            p.radius
          );
          pTarget.x = ex.x;
          pTarget.y = ex.y;
          pTarget.elev = ex.elevation;
        }
        const err = dist(p.x, p.y, pTarget.x, pTarget.y);
        if (err > 72) {
          p.x = pTarget.x;
          p.y = pTarget.y;
          p.elevation = pTarget.elev;
        } else if (err > 2) {
          const blend = Math.min(1, dt * (isMoving ? 6 : 16));
          p.x += (pTarget.x - p.x) * blend;
          p.y += (pTarget.y - p.y) * blend;
        }
      }

      const moved = dist(prevX, prevY, p.x, p.y);
      if (moved > 0.1) {
        if (this.status === 'PLAYING' && isMoving) {
          this.distanceSinceStep += moved;
          if (this.distanceSinceStep >= PLAYER_MOVEMENT.stepDistance) {
            this.distanceSinceStep %= PLAYER_MOVEMENT.stepDistance;
            sfx.footstep(this.getFootstepSurface(p.x, p.y));
          }
        }
        p.walkPhase += moved * 0.085;
        p.moveIntensity = Math.min(1, p.moveIntensity + dt * 10);
      } else {
        p.moveIntensity = Math.max(0, p.moveIntensity - dt * 10);
      }
      const ptr = this.getWorldPointer();
      p.angle = Math.atan2(ptr.y - p.y, ptr.x - p.x);
      this.updateActorSkillVisuals(p, dt);
      if (p.chargeReady) this.emitChargeReadyParticles(p, dt);
    }

    const remoteAlpha = Math.min(1, dt * 16);
    for (const e of this.enemies) {
      const t = this.clientLerpTargets.get(e.id);
      if (t) {
        if (t.extrapTime < 0.12 && (t.vx !== 0 || t.vy !== 0)) {
          const step = Math.min(dt, 0.12 - t.extrapTime);
          t.extrapTime += step;
          t.x = clamp(t.x + t.vx * step, e.radius, this.map.width - e.radius);
          t.y = clamp(t.y + t.vy * step, e.radius, this.map.height - e.radius);
        }
        const prevX = e.x;
        const prevY = e.y;
        e.x += (t.x - e.x) * remoteAlpha;
        e.y += (t.y - e.y) * remoteAlpha;
        e.angle += angleDiff(e.angle, t.angle) * remoteAlpha;
        const moved = dist(prevX, prevY, e.x, e.y);
        if (moved > 0.1) {
          e.walkPhase += moved * 0.085;
          e.moveIntensity = Math.min(1, e.moveIntensity + dt * 10);
        } else {
          e.moveIntensity = Math.max(0, e.moveIntensity - dt * 10);
        }
      }
      this.updateActorSkillVisuals(e, dt);
      if (e.hp > 0 && e.chargeReady) this.emitChargeReadyParticles(e, dt);
    }

    if (this.status === 'PLAYING' || this.status === 'RESPAWNING') {
      this.updateCamera(dt);
    }
    this.hudEmitTimer += dt;
    if (this.hudEmitTimer >= 0.09) {
      this.hudEmitTimer = 0;
      this.emitHud();
    }
  }

  public emitHud() {
    const p = this.player;
    const hostiles = this.enemies.filter((e) => areHostile(p.faction, 'player', e.faction, e.id));
    const weapon = p.weapons[p.activeHand];
    const offHandWeapon = p.weapons[p.activeHand === 0 ? 1 : 0];
    const activeSkill = this.siege
      ? getUltimateMeta(this.siege.playerState.loadout.ultimateId).name
      : weapon.type === 'melee'
        ? FACTIONS[p.faction].meleeSkills[weapon.def.kind].name
        : null;

    const buffs: string[] = [];
    const activeTimedSkills: HudSnapshot['player']['activeTimedSkills'] = [];
    if (p.royalShieldTimer > 0) {
      buffs.push(`聖光護盾 ${p.royalShieldTimer.toFixed(1)}s`);
      activeTimedSkills.push({ id: 'royalShield', name: '聖光護盾', remaining: p.royalShieldTimer, duration: 6.5, color: '#38BDF8' });
    }
    if (p.eagleEyeTimer > 0) {
      buffs.push(`鷹眼術 ${p.eagleEyeTimer.toFixed(1)}s`);
      activeTimedSkills.push({ id: 'eagleEye', name: '鷹眼術', remaining: p.eagleEyeTimer, duration: EAGLE_EYE_DURATION, color: '#FB7185' });
    }
    if (p.shadowCloneTimer > 0) {
      buffs.push(`影分身 ${p.shadowCloneTimer.toFixed(1)}s`);
      activeTimedSkills.push({ id: 'shadowClone', name: '影分身', remaining: p.shadowCloneTimer, duration: 6.5, color: '#A855F7' });
    }
    if (p.vampireTimer > 0) {
      buffs.push(`吸血術 ${p.vampireTimer.toFixed(1)}s`);
      activeTimedSkills.push({ id: 'vampire', name: '吸血術', remaining: p.vampireTimer, duration: 7.5, color: '#F43F5E' });
    }
    if (p.shrinkTimer > 0) {
      buffs.push(`縮小化 ${p.shrinkTimer.toFixed(1)}s`);
      activeTimedSkills.push({ id: 'shrink', name: '縮小化', remaining: p.shrinkTimer, duration: 7.5, color: '#FBBF24' });
    }
    if (p.giantTimer > 0) {
      buffs.push(`巨人化 ${p.giantTimer.toFixed(1)}s`);
      activeTimedSkills.push({ id: 'giant', name: '巨人化', remaining: p.giantTimer, duration: 7.5, color: '#F97316' });
    }
    if (p.freezeTimer > 0) {
      buffs.push(`冰凍 ${p.freezeTimer.toFixed(1)}s`);
      activeTimedSkills.push({ id: 'frozen', name: '冰凍', remaining: p.freezeTimer, duration: 5.0, color: '#38BDF8' });
    }

    const factionActive: Record<FactionId, number> = {
      royal: this.getActiveFactionCount('royal'),
      shadow: this.getActiveFactionCount('shadow'),
      mercenary: this.getActiveFactionCount('mercenary'),
    };
    const factionRemaining: Record<FactionId, number> = {
      royal: factionActive.royal + this.deploymentQueue.royal,
      shadow: factionActive.shadow + this.deploymentQueue.shadow,
      mercenary: factionActive.mercenary + this.deploymentQueue.mercenary,
    };
    const totalSoldiersRemaining =
      factionRemaining.royal + factionRemaining.shadow + factionRemaining.mercenary;

    this.onHudUpdate({
      mode: this.mode,
      mapId: this.mapId,
      mapName: this.map.name,
      status: this.status,
      respawnSeconds: Math.ceil(this.respawnTimer),
      spectating: this.isSpectating()
        ? {
            mode: this.spectatorMode,
            targetName:
              this.spectatorMode === 'follow' && this.spectatorTargetId
                ? this.enemies.find((e) => e.id === this.spectatorTargetId && e.hp > 0)?.name ?? null
                : null,
          }
        : null,
      enemiesRemaining: hostiles.length + (p.faction === 'mercenary'
        ? this.deploymentQueue.royal + this.deploymentQueue.shadow + this.deploymentQueue.mercenary
        : (['royal', 'shadow', 'mercenary'] as FactionId[])
            .filter((f) => f !== p.faction)
            .reduce((acc, f) => acc + this.deploymentQueue[f], 0)),
      totalSoldiersRemaining,
      factionRemaining,
      factionActive,
      bannerText: this.bannerTimer > 0 ? this.bannerText : '',
      activeSkillBanner: this.activeSkillBannerTimer > 0 ? this.activeSkillBanner : null,
      player: {
        hp: Math.round(p.hp),
        maxHp: p.maxHp,
        shield: weapon.type === 'melee' ? Math.round(weapon.durability) : 0,
        maxShield: p.maxShield,
        qi: Math.round(p.qi),
        maxQi: p.maxQi,
        lives: p.lives,
        maxLives: p.maxLives,
        reputation: p.reputations[p.faction],
        reputations: { ...p.reputations },
        qiSpeedMultiplier: getReputationQiMultiplier(p.reputations[p.faction]),
        score: Math.floor(p.score),
        totalDamage: p.totalDamage,
        kills: p.kills,
        comboCount: p.comboCount,
        maxCombo: p.maxCombo,
        faction: p.faction,
        characterSkin: p.characterSkin,
        weapon: { ...weapon },
        offHandWeapon: { ...offHandWeapon },
        reserveAmmo: Math.floor(p.reserveAmmo),
        maxReserveAmmo: p.maxReserveAmmo,
        reloadProgress: weapon.type === 'gun' && weapon.reloadTimer > 0
          ? Math.max(0.01, 1 - weapon.reloadTimer / weapon.def.reloadTime)
          : 0,
        isSwapping: p.swapTimer > 0,
        chargingMelee: p.chargingMelee && this.chargeSessionAllowed,
        chargeReady: p.chargeReady,
        comboEmpower: p.comboEmpowerTimer > 0,
        activeSkillName: activeSkill,
        activeBuffText: buffs.length > 0 ? buffs.join(' · ') : null,
        activeTimedSkills,
      },
      factionScores: { ...this.factionScores },
      siege: this.siege ? this.exportSiegeHudState() : null,
    });
  }

  // ==================== 3-Lane Castle Siege / MOBA Runtime ====================

  private initSiegeTeams() {
    if (!this.siege) return;
    const usedByFaction: Record<SiegeFactionId, Set<string>> = {
      royal: new Set<string>(),
      shadow: new Set<string>(),
    };
    const countByFaction: Record<SiegeFactionId, number> = { royal: 0, shadow: 0 };

    const pFac: SiegeFactionId = this.player.faction === 'shadow' ? 'shadow' : 'royal';
    usedByFaction[pFac].add(this.player.characterSkin.id);
    countByFaction[pFac] += 1;

    for (const rt of this.remoteHumans.values()) {
      const rFac: SiegeFactionId = rt.faction === 'shadow' ? 'shadow' : 'royal';
      usedByFaction[rFac].add(rt.characterSkin.id);
      countByFaction[rFac] += 1;
    }

    for (const fac of ['royal', 'shadow'] as SiegeFactionId[]) {
      let laneIdx = 0;
      while (countByFaction[fac] < SIEGE_CONFIG.teamSize) {
        const tpl = pickSiegeAiHeroTemplate(fac, usedByFaction[fac], laneIdx++);
        usedByFaction[fac].add(tpl.skinId);
        const skin = this.resolveSkinById(tpl.skinId, fac);
        const hero = this.spawnSiegeHero(fac, tpl.skinId, tpl.loadout, tpl.lane, skin.name);
        this.enemies.push(hero);
        countByFaction[fac] += 1;
      }
    }
  }

  private spawnSiegeHero(
    faction: SiegeFactionId,
    skinId: string,
    loadout: SiegePlayerLoadout,
    lane: SiegeLane,
    name: string,
    existingGold = 120,
    existingUpgrades = { firepower: 0, blade: 0, armor: 0, core: 0 },
    existingDeaths = 0
  ): EnemyEntity {
    const fountain = this.siege!.spec.fountains[faction];
    const jitter = ((Math.random() - 0.5) * 48);
    const jitterY = ((Math.random() - 0.5) * 48);
    const sx = clamp(fountain.x + jitter, TILE * 1.5, this.map.width - TILE * 1.5);
    const sy = clamp(fountain.y + jitterY, TILE * 1.5, this.map.height - TILE * 1.5);
    const skin = this.resolveSkinById(skinId, faction);
    const gun = ALL_GUNS_BY_ID.get(loadout.gunId) || DEFAULT_PISTOL;
    const melee = ALL_MELEES_BY_ID.get(loadout.meleeId) || DEFAULT_KNIFE;
    const initLevel = Math.min(10, 1 + Math.floor((this.siege?.matchTime ?? 0) / 95) + Math.floor(existingGold / 360));
    const maxHp = computeSiegeMaxHp({ level: initLevel, upgrades: existingUpgrades, loadout });
    const hero: EnemyEntity = {
      id: uid('siege_hero'),
      name,
      archetype: gun.kind === 'sniper' ? 'sniper' : gun.kind === 'shotgun' ? 'rusher' : 'trooper',
      faction,
      isAlly: faction === this.player.faction,
      activeHand: 0,
      weapons: [equipGun(gun), { type: 'melee', def: melee, durability: melee.kind === 'shield' ? 100 : 0 }],
      swapTimer: 0,
      swapDuration: 0,
      x: sx,
      y: sy,
      vx: 0,
      vy: 0,
      baseRadius: CHAR_BASE_RADIUS,
      radius: CHAR_BASE_RADIUS,
      sizeScale: 1,
      angle: faction === 'royal' ? -Math.PI / 4 : (3 * Math.PI) / 4,
      walkPhase: 0,
      moveIntensity: 0,
      elevation: this.getWalkableElevation(sx, sy),
      hp: maxHp,
      maxHp,
      qi: 100,
      maxQi: 100,
      chargingMelee: false,
      chargeReady: false,
      speed: 158,
      attackCooldown: 0.5,
      aiTimer: Math.random() * 2,
      lastSeenTargetPos: null,
      alertTimer: 0,
      hasLosToTarget: false,
      visibleTargetId: null,
      reactionTimer: 0,
      focusedTargetId: null,
      aggroLockTimer: 0,
      pathTiles: [],
      pathTimer: 0,
      patrolAnchor: { x: sx, y: sy },
      patrolTarget: null,
      patrolTimer: 0,
      royalShieldTimer: 0,
      eagleEyeTimer: 0,
      shadowCloneTimer: 0,
      vampireTimer: 0,
      shrinkTimer: 0,
      giantTimer: 0,
      blindTimer: 0,
      stunTimer: 0,
      freezeTimer: 0,
      invulnTimer: 1.5,
      hitFlash: 0,
      gunfireTimer: 0,
      crosshairBloom: 0,
      bloomDelayTimer: 0,
      lastAimAngle: 0,
      attackAnimTimer: 0,
      attackAnimDuration: 0,
      attackAnimKind: null,
      color: FACTIONS[faction].accentHex,
      characterSkin: skin,
      siegeUnitKind: 'hero',
      siegeLane: lane,
      siegeWaypointIdx: faction === 'royal' ? 0 : this.siege!.spec.laneWaypoints[lane].length - 1,
      siegeLoadout: { ...loadout },
      siegeTacticalCd: 1.5,
      siegeDeaths: existingDeaths,
      siegeLevel: initLevel,
      siegeGold: existingGold,
      siegeUpgrades: { ...existingUpgrades },
    };
    return hero;
  }

  private spawnSiegeMinionWave() {
    if (!this.siege) return;
    const activeMinions = this.enemies.filter(
      (e) => e.siegeUnitKind === 'minion' || e.siegeUnitKind === 'super_minion'
    ).length;
    if (activeMinions >= SIEGE_CONFIG.maxActiveMinions) return;

    this.siege.waveNumber += 1;
    const lanes: SiegeLane[] = ['top', 'mid', 'bot'];
    const minionKnifeDef: MeleeDef = {
      id: 'siege_minion_knife',
      kind: 'knife',
      name: '軍用小刀',
      damage: 8,
      swingRate: 2.0,
      moveSpeedMult: 0.92,
      reach: 54,
      arc: Math.PI * 0.48,
      color: '#38BDF8',
    };
    const minionGreatswordDef: MeleeDef = {
      id: 'siege_minion_greatsword',
      kind: 'greatsword',
      name: '重裝大刀',
      damage: 16,
      swingRate: 1.0,
      moveSpeedMult: 0.78,
      reach: 70,
      arc: Math.PI * 0.85,
      color: '#F59E0B',
    };
    const minionSuperDef: MeleeDef = {
      id: 'siege_super_greatsword',
      kind: 'greatsword',
      name: '攻城巨刃',
      damage: 22,
      swingRate: 1.15,
      moveSpeedMult: 0.82,
      reach: 76,
      arc: Math.PI * 0.92,
      color: '#FB7185',
    };

    for (const fac of ['royal', 'shadow'] as SiegeFactionId[]) {
      const opp: SiegeFactionId = fac === 'royal' ? 'shadow' : 'royal';
      const baronActive = this.siege.teamBuffs[fac].baronTimer > 0;
      const defaultSkin = FACTION_CHARACTERS[fac][0];
      for (const lane of lanes) {
        const wps = this.siege.spec.laneWaypoints[lane];
        const spawnPt = fac === 'royal' ? wps[0] : wps[wps.length - 1];
        const oppInner = this.siege.structures.find((s) => s.id === `${opp}_${lane}_inner`);
        const spawnSuper = this.siege.suddenDeath || Boolean(oppInner && !oppInner.alive);

        const specs: { kind: 'minion' | 'super_minion'; tier: 'heavy' | 'light'; hp: number }[] = [
          {
            kind: spawnSuper ? 'super_minion' : 'minion',
            tier: 'heavy',
            hp: Math.round((spawnSuper ? 260 : 165) * (baronActive ? 1.35 : 1)),
          },
          { kind: 'minion', tier: 'light', hp: Math.round(95 * (baronActive ? 1.35 : 1)) },
          { kind: 'minion', tier: 'light', hp: Math.round(95 * (baronActive ? 1.35 : 1)) },
        ];

        specs.forEach((sp, idx) => {
          const rawX = clamp(spawnPt.x + (idx - 1) * 18, TILE, this.map.width - TILE);
          const rawY = clamp(spawnPt.y + (idx - 1) * 14, TILE, this.map.height - TILE);
          const isSuper = sp.kind === 'super_minion';
          const isHeavy = sp.tier === 'heavy';
          const mRadius = isSuper ? 18 : isHeavy ? 16 : 13;
          const rawElev = this.getWalkableElevation(rawX, rawY);
          const spawnValid =
            this.canStandWithPadding(rawX, rawY, rawElev, mRadius) &&
            !this.isBlockedByAliveSiegeStructure(rawX, rawY, getMoveCheckRadius(mRadius));
          const sx = spawnValid ? rawX : spawnPt.x;
          const sy = spawnValid ? rawY : spawnPt.y;
          const primaryDef = isSuper ? minionSuperDef : isHeavy ? minionGreatswordDef : minionKnifeDef;
          const weapons: [EquippedWeapon, EquippedWeapon] = [
            { type: 'melee', def: primaryDef, durability: 0 },
            { type: 'melee', def: minionKnifeDef, durability: 0 },
          ];
          this.enemies.push({
            id: uid('minion'),
            name: isSuper ? '攻城重斬精英' : isHeavy ? '重甲大刀兵' : '先鋒小刀兵',
            archetype: 'rusher',
            faction: fac,
            isAlly: fac === this.player.faction,
            activeHand: 0,
            weapons,
            swapTimer: 0,
            swapDuration: 0,
            x: sx,
            y: sy,
            vx: 0,
            vy: 0,
            baseRadius: mRadius,
            radius: mRadius,
            sizeScale: isSuper ? 0.92 : isHeavy ? 0.8 : 0.65,
            angle: fac === 'royal' ? -Math.PI / 4 : (3 * Math.PI) / 4,
            walkPhase: 0,
            moveIntensity: 0,
            elevation: this.getWalkableElevation(sx, sy),
            hp: sp.hp,
            maxHp: sp.hp,
            qi: 0,
            maxQi: 100,
            chargingMelee: false,
            chargeReady: false,
            speed: isSuper ? 112 : isHeavy ? 100 : 112,
            attackCooldown: 0.4,
            aiTimer: Math.random(),
            lastSeenTargetPos: null,
            alertTimer: 0,
            hasLosToTarget: false,
            visibleTargetId: null,
            reactionTimer: 0,
            focusedTargetId: null,
            aggroLockTimer: 0,
            pathTiles: [],
            pathTimer: 0,
            patrolAnchor: { x: sx, y: sy },
            patrolTarget: null,
            patrolTimer: 0,
            royalShieldTimer: 0,
            eagleEyeTimer: 0,
            shadowCloneTimer: 0,
            vampireTimer: 0,
            shrinkTimer: 0,
            giantTimer: 0,
            blindTimer: 0,
            stunTimer: 0,
            freezeTimer: 0,
            hitFlash: 0,
            gunfireTimer: 0,
            crosshairBloom: 0,
            bloomDelayTimer: 0,
            lastAimAngle: 0,
            attackAnimTimer: 0,
            attackAnimDuration: 0,
            attackAnimKind: null,
            color: FACTIONS[fac].accentHex,
            characterSkin: defaultSkin,
            siegeUnitKind: sp.kind,
            siegeLane: lane,
            siegeWaypointIdx: fac === 'royal' ? 0 : wps.length - 1,
          });
        });
      }
    }
  }

  private spawnSiegeVanguardAlly(faction: SiegeFactionId) {
    if (!this.siege) return;
    const fountain = this.siege.spec.fountains[faction];
    const wps = this.siege.spec.laneWaypoints.mid;
    const gun = ALL_GUNS_BY_ID.get('shotgun') || DEFAULT_PISTOL;
    const greatsword = ALL_MELEES_BY_ID.get('greatsword') || DEFAULT_KNIFE;
    const skin = this.resolveSkinById('merc_mirage', 'mercenary');
    this.enemies.push({
      id: uid('vanguard_ally'),
      name: `${FACTIONS[faction].name}・攻城先鋒`,
      archetype: 'heavy',
      faction,
      isAlly: faction === this.player.faction,
      activeHand: 0,
      weapons: [equipGun(gun), { type: 'melee', def: greatsword, durability: 0 }],
      swapTimer: 0,
      swapDuration: 0,
      x: fountain.x,
      y: fountain.y,
      vx: 0,
      vy: 0,
      baseRadius: CHAR_BASE_RADIUS * 1.15,
      radius: CHAR_BASE_RADIUS * 1.15,
      sizeScale: 1.15,
      angle: 0,
      walkPhase: 0,
      moveIntensity: 0,
      elevation: this.getWalkableElevation(fountain.x, fountain.y),
      hp: 650,
      maxHp: 650,
      qi: 0,
      maxQi: 100,
      chargingMelee: false,
      chargeReady: false,
      speed: 132,
      attackCooldown: 0.4,
      aiTimer: 0,
      lastSeenTargetPos: null,
      alertTimer: 0,
      hasLosToTarget: false,
      visibleTargetId: null,
      reactionTimer: 0,
      focusedTargetId: null,
      aggroLockTimer: 0,
      pathTiles: [],
      pathTimer: 0,
      patrolAnchor: { x: fountain.x, y: fountain.y },
      patrolTarget: null,
      patrolTimer: 0,
      royalShieldTimer: 0,
      eagleEyeTimer: 0,
      shadowCloneTimer: 0,
      vampireTimer: 0,
      shrinkTimer: 0,
      giantTimer: 0,
      blindTimer: 0,
      stunTimer: 0,
      freezeTimer: 0,
      hitFlash: 0,
      gunfireTimer: 0,
      crosshairBloom: 0,
      bloomDelayTimer: 0,
      lastAimAngle: 0,
      attackAnimTimer: 0,
      attackAnimDuration: 0,
      attackAnimKind: null,
      color: FACTIONS[faction].accentHex,
      characterSkin: skin,
      siegeUnitKind: 'vanguard_ally',
      siegeLane: 'mid',
      siegeWaypointIdx: faction === 'royal' ? 0 : wps.length - 1,
    });
  }

  private spawnSiegeJungleUnit(campId: string) {
    if (!this.siege) return;
    const camp = this.siege.spec.jungleCamps.find((c) => c.id === campId);
    if (!camp) return;
    const skin = this.resolveSkinById(camp.skinId, 'mercenary');
    const rifle = ALL_GUNS_BY_ID.get('rifle') || DEFAULT_PISTOL;
    this.enemies.push({
      id: `${camp.id}_${uid('j')}`,
      name: camp.name,
      archetype: 'trooper',
      faction: 'mercenary',
      isAlly: false,
      activeHand: 0,
      weapons: [equipGun(rifle), { type: 'melee', def: DEFAULT_KNIFE, durability: 0 }],
      swapTimer: 0,
      swapDuration: 0,
      x: camp.x,
      y: camp.y,
      vx: 0,
      vy: 0,
      baseRadius: CHAR_BASE_RADIUS,
      radius: CHAR_BASE_RADIUS,
      sizeScale: 1,
      angle: Math.random() * Math.PI * 2,
      walkPhase: 0,
      moveIntensity: 0,
      elevation: this.getWalkableElevation(camp.x, camp.y),
      hp: 260,
      maxHp: 260,
      qi: 0,
      maxQi: 100,
      chargingMelee: false,
      chargeReady: false,
      speed: 130,
      attackCooldown: 0.6,
      aiTimer: 0,
      lastSeenTargetPos: null,
      alertTimer: 0,
      hasLosToTarget: false,
      visibleTargetId: null,
      reactionTimer: 0,
      focusedTargetId: null,
      aggroLockTimer: 0,
      pathTiles: [],
      pathTimer: 0,
      patrolAnchor: { x: camp.x, y: camp.y },
      patrolTarget: null,
      patrolTimer: 0,
      royalShieldTimer: 0,
      eagleEyeTimer: 0,
      shadowCloneTimer: 0,
      vampireTimer: 0,
      shrinkTimer: 0,
      giantTimer: 0,
      blindTimer: 0,
      stunTimer: 0,
      freezeTimer: 0,
      hitFlash: 0,
      gunfireTimer: 0,
      crosshairBloom: 0,
      bloomDelayTimer: 0,
      lastAimAngle: 0,
      attackAnimTimer: 0,
      attackAnimDuration: 0,
      attackAnimKind: null,
      color: FACTIONS.mercenary.accentHex,
      characterSkin: skin,
      siegeUnitKind: 'jungle',
      siegeHomePos: { x: camp.x, y: camp.y },
    });
  }

  public spawnSiegeBoss(kind: SiegeBossKind) {
    if (!this.siege) return;
    const spot = this.siege.spec.bossSpawns[kind];
    const isBaron = kind === 'baron';
    const skin = this.resolveSkinById(isBaron ? 'merc_titan' : 'merc_mirage', 'mercenary');
    const gun = ALL_GUNS_BY_ID.get(isBaron ? 'shotgun' : 'rifle') || DEFAULT_PISTOL;
    const melee = ALL_MELEES_BY_ID.get(isBaron ? 'greatsword' : 'claw') || DEFAULT_KNIFE;
    const maxHp = isBaron ? 2400 : 850;
    const scale = isBaron ? 1.35 : 1.1;
    this.enemies.push({
      id: uid(`boss_${kind}`),
      name: getBossDisplayName(kind),
      archetype: isBaron ? 'heavy' : 'phantom',
      faction: 'mercenary',
      isAlly: false,
      activeHand: 0,
      weapons: [equipGun(gun), { type: 'melee', def: melee, durability: 0 }],
      swapTimer: 0,
      swapDuration: 0,
      x: spot.x,
      y: spot.y,
      vx: 0,
      vy: 0,
      baseRadius: CHAR_BASE_RADIUS,
      radius: CHAR_BASE_RADIUS * scale,
      sizeScale: scale,
      angle: 0,
      walkPhase: 0,
      moveIntensity: 0,
      elevation: this.getWalkableElevation(spot.x, spot.y),
      hp: maxHp,
      maxHp,
      qi: 100,
      maxQi: 100,
      chargingMelee: false,
      chargeReady: false,
      speed: isBaron ? 128 : 150,
      attackCooldown: 0.7,
      aiTimer: 0,
      lastSeenTargetPos: null,
      alertTimer: 0,
      hasLosToTarget: false,
      visibleTargetId: null,
      reactionTimer: 0,
      focusedTargetId: null,
      aggroLockTimer: 0,
      pathTiles: [],
      pathTimer: 0,
      patrolAnchor: { x: spot.x, y: spot.y },
      patrolTarget: null,
      patrolTimer: 0,
      royalShieldTimer: 0,
      eagleEyeTimer: 0,
      shadowCloneTimer: 0,
      vampireTimer: 0,
      shrinkTimer: 0,
      giantTimer: isBaron ? 4 : 0,
      blindTimer: 0,
      stunTimer: 0,
      freezeTimer: 0,
      hitFlash: 0,
      gunfireTimer: 0,
      crosshairBloom: 0,
      bloomDelayTimer: 0,
      lastAimAngle: 0,
      attackAnimTimer: 0,
      attackAnimDuration: 0,
      attackAnimKind: null,
      color: '#F59E0B',
      characterSkin: skin,
      siegeUnitKind: 'boss',
      siegeBossKind: kind,
      siegeHomePos: { x: spot.x, y: spot.y },
    });
    if (kind === 'baron') {
      this.siege.baronState = 'alive';
      this.showBanner('【終極 Boss 降臨】上河道「狂戰巨神・重砲鐵拳」已登場！', 4.0);
    } else {
      this.siege.vanguardState = 'alive';
      this.showBanner('【中期 Boss 登場】下河道「幻沙先鋒・雙影巨獸」現身！', 3.5);
    }
  }

  public triggerSiegeTactical() {
    if (this.mode !== 'siege' || !this.siege || this.status !== 'PLAYING') return;
    if (this.multiplayer?.role === 'client') return;
    const p = this.player;
    const ps = this.siege.playerState;
    if (p.hp <= 0 || p.freezeTimer > 0) return;
    if (ps.level < SIEGE_CONFIG.tacticalUnlockLevel) {
      this.spawnText(p.x, p.y - 34, `Lv.${SIEGE_CONFIG.tacticalUnlockLevel} 解鎖戰術技`, '#94A3B8', 0.9, true);
      return;
    }
    if (ps.tacticalCd > 0) {
      this.spawnText(p.x, p.y - 34, `冷卻中 (${ps.tacticalCd.toFixed(1)}s)`, '#94A3B8', 0.9, true);
      return;
    }
    const ptr = this.getWorldPointer();
    ps.recallTimer = 0;
    this.castSiegeTacticalSkill('player', p, ps.loadout, ptr.x, ptr.y);
    ps.tacticalCd = computeSiegeTacticalCooldown(ps);
    this.emitHud();
  }

  public triggerSiegeUltimate() {
    if (this.mode !== 'siege' || !this.siege || this.status !== 'PLAYING') return;
    if (this.multiplayer?.role === 'client') return;
    const p = this.player;
    const ps = this.siege.playerState;
    if (p.hp <= 0 || p.freezeTimer > 0) return;
    if (ps.level < SIEGE_CONFIG.ultimateUnlockLevel) {
      this.spawnText(p.x, p.y - 34, `Lv.${SIEGE_CONFIG.ultimateUnlockLevel} 解鎖大招（需切近戰集氣釋放）`, '#94A3B8', 0.9, true);
      return;
    }
    this.spawnText(p.x, p.y - 34, '請按 [Q] 切換近戰並長按左鍵集氣釋放！', '#FACC15', 0.95, true);
  }

  public startSiegeRecall() {
    if (this.mode !== 'siege' || !this.siege || this.status !== 'PLAYING') return;
    if (this.multiplayer?.role === 'client') return;
    const p = this.player;
    const ps = this.siege.playerState;
    if (p.hp <= 0) return;
    const fac: SiegeFactionId = p.faction === 'shadow' ? 'shadow' : 'royal';
    if (this.isInsideOwnFountain(p.x, p.y, fac)) {
      this.spawnText(p.x, p.y - 34, '已在基地泉水內', '#38BDF8', 0.9, true);
      return;
    }
    ps.recallTimer = SIEGE_CONFIG.recallDurationSec;
    this.spawnText(p.x, p.y - 38, '回城引導中 (3.5s)...', '#38BDF8', 1.0);
    this.emitHud();
  }

  public buySiegeUpgrade(track: SiegeUpgradeTrack): boolean {
    if (this.mode !== 'siege' || !this.siege) return false;
    if (this.multiplayer?.role === 'client') return false;
    const p = this.player;
    const ps = this.siege.playerState;
    const fac: SiegeFactionId = p.faction === 'shadow' ? 'shadow' : 'royal';
    const canShop = this.status === 'RESPAWNING' || this.isInsideOwnFountain(p.x, p.y, fac);
    if (!canShop) {
      this.spawnText(p.x, p.y - 36, '須回泉水 [B] 或復活時升級', '#FBBF24', 0.95);
      return false;
    }
    const res = tryPurchaseSiegeUpgrade(ps, track);
    if (!res.ok) {
      this.spawnText(p.x, p.y - 36, res.reason || '無法升級', '#F87171', 0.95);
      return false;
    }
    if (track === 'armor') {
      p.maxHp = computeSiegeMaxHp(ps);
      if (p.hp > 0) p.hp = Math.min(p.maxHp, p.hp + 32);
    }
    sfx.pickup();
    const meta = SIEGE_UPGRADES.find((u) => u.track === track);
    this.spawnText(p.x, p.y - 40, `${meta?.name ?? track} Lv.${res.level}!`, meta?.color ?? '#FACC15', 1.15);
    this.emitHud();
    return true;
  }

  private castSiegeTacticalSkill(
    casterId: string,
    caster: PlayerState | EnemyEntity,
    loadout: SiegePlayerLoadout,
    aimX: number,
    aimY: number
  ) {
    if (!this.siege) return;
    const fac: SiegeFactionId = caster.faction === 'shadow' ? 'shadow' : 'royal';
    const meta = getTacticalMeta(loadout.tacticalId);
    const heroState = this.getSiegeHeroState(casterId);
    const tacRank = heroState?.upgrades.blade ?? ('siegeUpgrades' in caster ? caster.siegeUpgrades?.blade ?? 0 : 0);
    const tacMult = 1 + tacRank * 0.25;
    const rangeMult = 1 + tacRank * 0.08;
    this.spawnText(caster.x, caster.y - 40, tacRank > 0 ? `${meta.name} +${tacRank}` : meta.name, meta.color, 1.15);
    sfx.ultimate();
    this.emitNetSfx('skill', caster.x, caster.y);

    if (loadout.tacticalId === 'royal_aegis_reflect') {
      const dur = 3.5 + tacRank * 0.45;
      if (casterId === 'player') {
        this.siege.playerState.aegisReflectTimer = dur;
      } else if ('siegeAegisReflectTimer' in caster) {
        caster.siegeAegisReflectTimer = dur;
        const rState = caster.peerId ? this.siege.remoteStates.get(caster.peerId) : undefined;
        if (rState) rState.aegisReflectTimer = dur;
      }
      this.spawnBurst(caster.x, caster.y, '#38BDF8', 14);
      return;
    }

    if (loadout.tacticalId === 'royal_sanctuary_zone') {
      const life = 4.5 + tacRank * 0.4;
      this.siege.zones.push({
        id: uid('zone'),
        kind: 'sanctuary',
        faction: fac,
        ownerId: casterId,
        x: caster.x,
        y: caster.y,
        radius: Math.round(160 * rangeMult),
        life,
        maxLife: life,
        tickTimer: 0.2,
        heal: Math.round(7 * tacMult),
      });
      return;
    }

    if (loadout.tacticalId === 'royal_dash_bash') {
      const ang = Math.atan2(aimY - caster.y, aimX - caster.x);
      const maxDash = Math.round(190 * rangeMult);
      const d = Math.min(maxDash, Math.max(40, dist(caster.x, caster.y, aimX, aimY)));
      const spot = this.findSafeTeleportSpot(
        caster.x + Math.cos(ang) * d,
        caster.y + Math.sin(ang) * d,
        ang,
        4,
        caster.radius,
        caster.x,
        caster.y
      );
      this.addSkillTrace('blink', caster, spot, 0.45);
      caster.x = spot.x;
      caster.y = spot.y;
      caster.elevation = this.getWalkableElevation(caster.x, caster.y);
      const bashRadius = Math.round(115 * rangeMult);
      this.pushSlash({
        x: caster.x,
        y: caster.y,
        angle: ang,
        arc: Math.PI * 2,
        reach: bashRadius,
        color: '#60A5FA',
        life: 0.24,
        maxLife: 0.24,
        isUltimate: true,
        style: 'sweep',
      });
      const bashDmg = Math.round(25 * tacMult);
      const stunDur = 0.8 + tacRank * 0.1;
      if (casterId !== 'player' && this.player.hp > 0 && areHostile(fac, casterId, this.player.faction, 'player')) {
        if (dist(caster.x, caster.y, this.player.x, this.player.y) <= bashRadius + this.player.radius) {
          this.damagePlayer(bashDmg, true, casterId, caster.x, caster.y);
        }
      }
      for (const e of [...this.enemies]) {
        if (e.id === casterId || !areHostile(fac, casterId, e.faction, e.id)) continue;
        if (dist(caster.x, caster.y, e.x, e.y) <= bashRadius + e.radius) {
          const pushA = Math.atan2(e.y - caster.y, e.x - caster.x);
          this.damageEnemy(e, bashDmg, true, Math.cos(pushA) * 520, Math.sin(pushA) * 520, false, true, casterId, fac, caster.x, caster.y);
          if (e.hp > 0) e.stunTimer = Math.max(e.stunTimer, stunDur);
        }
      }
      return;
    }

    if (loadout.tacticalId === 'shadow_blink_swap') {
      this.siege.zones.push({
        id: uid('decoy'),
        kind: 'decoy',
        faction: fac,
        ownerId: casterId,
        x: caster.x,
        y: caster.y,
        radius: Math.round(110 * rangeMult),
        life: 1.4,
        maxLife: 1.4,
        tickTimer: 99,
        damage: Math.round(38 * tacMult),
      });
      const ang = Math.atan2(aimY - caster.y, aimX - caster.x);
      const maxDash = Math.round(190 * rangeMult);
      const d = Math.min(maxDash, Math.max(50, dist(caster.x, caster.y, aimX, aimY)));
      const spot = this.findSafeTeleportSpot(
        caster.x + Math.cos(ang) * d,
        caster.y + Math.sin(ang) * d,
        ang,
        4,
        caster.radius,
        caster.x,
        caster.y
      );
      this.addSkillTrace('blink', caster, spot, 0.48);
      caster.x = spot.x;
      caster.y = spot.y;
      caster.elevation = this.getWalkableElevation(caster.x, caster.y);
      return;
    }

    if (loadout.tacticalId === 'shadow_hunter_mark') {
      caster.eagleEyeTimer = Math.max(caster.eagleEyeTimer, 4.5 + tacRank * 0.5);
      const markDur = 5.0 + tacRank * 0.6;
      const maxMarks = tacRank >= 3 ? 3 : 2;
      let markedCount = 0;
      if (casterId !== 'player' && this.player.hp > 0 && areHostile(fac, casterId, this.player.faction, 'player')) {
        if (dist(caster.x, caster.y, this.player.x, this.player.y) <= 480) {
          this.siege.playerState.markedTimer = markDur;
          this.spawnText(this.player.x, this.player.y - 36, '被獵殺標記!', '#FB7185', 1.0);
          markedCount += 1;
        }
      }
      const nearEnemies = this.enemies
        .filter((e) => areHostile(fac, casterId, e.faction, e.id) && dist(caster.x, caster.y, e.x, e.y) <= 480)
        .sort((a, b) => dist(caster.x, caster.y, a.x, a.y) - dist(caster.x, caster.y, b.x, b.y));
      for (const target of nearEnemies) {
        if (markedCount >= maxMarks) break;
        target.siegeMarkedTimer = markDur;
        this.spawnText(target.x, target.y - 34, '獵殺標記 +22%傷', '#FB7185', 0.95);
        markedCount += 1;
      }
      return;
    }

    // shadow_smoke_shroud
    const shroudDur = 3.5 + tacRank * 0.45;
    caster.shadowCloneTimer = Math.max(caster.shadowCloneTimer, shroudDur);
    if (casterId === 'player') {
      this.siege.playerState.smokeSpeedTimer = shroudDur;
    } else if ('peerId' in caster && caster.peerId) {
      const rState = this.siege.remoteStates.get(caster.peerId);
      if (rState) rState.smokeSpeedTimer = shroudDur;
    }
    this.spawnBurst(caster.x, caster.y, '#A855F7', 12);
  }

  private castSiegeUltimateSkill(
    casterId: string,
    caster: PlayerState | EnemyEntity,
    ultId: SiegePlayerLoadout['ultimateId'],
    aimAngle: number,
    comboMult: number
  ) {
    if (!this.siege) return;
    const fac: SiegeFactionId = caster.faction === 'shadow' ? 'shadow' : 'royal';
    const heroState = this.getSiegeHeroState(casterId);
    const ultRank = heroState?.upgrades.core ?? ('siegeUpgrades' in caster ? caster.siegeUpgrades?.core ?? 0 : 0);
    const ultMult = (1 + ultRank * 0.25) * comboMult;
    const evolved = ultRank >= 3;
    const ultMeta = getUltimateMeta(ultId);
    this.spawnText(
      caster.x,
      caster.y - 44,
      evolved ? `${ultMeta.name}・覺醒!` : ultRank > 0 ? `${ultMeta.name} Lv.${ultRank}!` : `${ultMeta.name}!`,
      ultMeta.color,
      1.3
    );

    if (ultId === 'royal_judgment_beam') {
      const range = 760 + ultRank * 55;
      const wallSeg = this.traceBulletSegment(caster.x, caster.y, aimAngle, range, caster.elevation, false);
      const endX = wallSeg.x2;
      const endY = wallSeg.y2;
      this.pushBeam({
        x1: caster.x + Math.cos(aimAngle) * 20,
        y1: caster.y + Math.sin(aimAngle) * 20,
        x2: endX,
        y2: endY,
        color: '#FDE047',
        life: 0.34,
        maxLife: 0.34,
        width: 14 + ultRank * 2.5,
      });
      const unitDmg = Math.round(75 * ultMult);
      const structDmg = Math.round(180 * ultMult);
      if (casterId !== 'player' && this.player.hp > 0 && areHostile(fac, casterId, this.player.faction, 'player')) {
        const hit = segmentCircleHit(caster.x, caster.y, endX, endY, this.player.x, this.player.y, this.player.radius + 14);
        if (hit.hit) this.damagePlayer(unitDmg, false, casterId, caster.x, caster.y);
      }
      for (const e of [...this.enemies]) {
        if (e.id === casterId || !areHostile(fac, casterId, e.faction, e.id)) continue;
        const hit = segmentCircleHit(caster.x, caster.y, endX, endY, e.x, e.y, e.radius + 14);
        if (hit.hit) {
          this.damageEnemy(e, unitDmg, false, Math.cos(aimAngle) * 180, Math.sin(aimAngle) * 180, true, true, casterId, fac, caster.x, caster.y);
        }
      }
      const hitStructures = this.siege.structures
        .filter((st) => st.alive && st.faction !== fac)
        .map((st) => ({ st, hit: segmentCircleHit(caster.x, caster.y, endX, endY, st.x, st.y, st.radius + 10) }))
        .filter((x) => x.hit.hit)
        .sort((a, b) => a.hit.t - b.hit.t);
      if (hitStructures.length > 0) {
        this.damageSiegeStructure(hitStructures[0].st, structDmg, casterId, fac);
      }
      return;
    }

    if (ultId === 'royal_light_rain' || ultId === 'royal_healing_salvo') {
      const isHeal = ultId === 'royal_healing_salvo';
      const spreadAngles = isHeal
        ? evolved
          ? [-0.42, -0.28, -0.14, 0, 0.14, 0.28, 0.42]
          : [-0.3, -0.15, 0, 0.15, 0.3]
        : evolved
          ? [-0.55, -0.44, -0.33, -0.22, -0.11, 0, 0.11, 0.22, 0.33, 0.44, 0.55]
          : [-0.48, -0.36, -0.24, -0.12, 0, 0.12, 0.24, 0.36, 0.48];
      const dmg = Math.round((isHeal ? 32 : 28) * ultMult);
      const orbRadius = Math.round(16 + ultRank * 2.4 + (evolved ? 3 : 0));
      const slashReach = Math.round(96 + ultRank * 14 + (evolved ? 18 : 0));
      this.pushSlash({
        x: caster.x,
        y: caster.y,
        angle: aimAngle,
        arc: isHeal ? Math.PI * 0.95 : Math.PI * 1.15,
        reach: slashReach,
        color: isHeal ? '#4ADE80' : '#FACC15',
        life: 0.26,
        maxLife: 0.26,
        isUltimate: true,
        style: 'sweep',
      });
      for (const off of spreadAngles) {
        const a = aimAngle + off;
        this.projectiles.push({
          id: uid('lightorb'),
          x: caster.x + Math.cos(a) * 26,
          y: caster.y + Math.sin(a) * 26,
          prevX: caster.x,
          prevY: caster.y,
          vx: Math.cos(a) * 580,
          vy: Math.sin(a) * 580,
          radius: orbRadius,
          damage: dmg,
          startElevation: caster.elevation,
          minTraversedElevation: caster.elevation,
          ownerId: casterId,
          ownerFaction: fac,
          fromPlayer: casterId === 'player',
          isAlly: fac === this.player.faction,
          noFriendlyFire: true,
          healAllies: isHeal,
          color: isHeal ? '#4ADE80' : '#FACC15',
          life: 1.25,
          maxLife: 1.25,
          pierce: 8,
          isLightOrb: true,
          hitIds: new Set(),
        });
      }
      return;
    }

    if (ultId === 'shadow_twin_dragons') {
      const headDmg = Math.round(24 * ultMult);
      const bodyDmg = Math.round(16 * ultMult);
      const dragonAngles = evolved ? [-0.18, 0, 0.18] : [-0.14, 0.14];
      for (const off of dragonAngles) {
        const a = aimAngle + off;
        const startX = caster.x + Math.cos(a) * 26;
        const startY = caster.y + Math.sin(a) * 26;
        this.projectiles.push({
          id: uid('blackdragon'),
          x: startX,
          y: startY,
          prevX: caster.x,
          prevY: caster.y,
          vx: Math.cos(a) * 420,
          vy: Math.sin(a) * 420,
          radius: 19,
          damage: headDmg,
          headDamage: headDmg,
          bodyDamage: bodyDmg,
          startElevation: caster.elevation,
          minTraversedElevation: caster.elevation,
          ownerId: casterId,
          ownerFaction: fac,
          fromPlayer: casterId === 'player',
          isAlly: fac === this.player.faction,
          noFriendlyFire: true,
          color: '#312E81',
          life: 2.6,
          maxLife: 2.6,
          pierce: 99,
          isWave: true,
          isBlackDragon: true,
          segments: [{ x: startX, y: startY }],
          bouncesLeft: 3,
          distanceTraveled: 0,
          maxDistance: 900,
          targetHitCooldowns: {},
          hitIds: new Set(),
        });
      }
      return;
    }

    if (ultId === 'shadow_pierce_dragon') {
      const headDmg = Math.round(55 * ultMult);
      const bodyDmg = Math.round(38 * ultMult);
      const speed = 640 + ultRank * 35;
      const startX = caster.x + Math.cos(aimAngle) * 28;
      const startY = caster.y + Math.sin(aimAngle) * 28;
      this.projectiles.push({
        id: uid('piercedragon'),
        x: startX,
        y: startY,
        prevX: caster.x,
        prevY: caster.y,
        vx: Math.cos(aimAngle) * speed,
        vy: Math.sin(aimAngle) * speed,
        radius: 22 + ultRank * 2,
        damage: headDmg,
        headDamage: headDmg,
        bodyDamage: bodyDmg,
        startElevation: caster.elevation,
        minTraversedElevation: caster.elevation,
        ownerId: casterId,
        ownerFaction: fac,
        fromPlayer: casterId === 'player',
        isAlly: fac === this.player.faction,
        noFriendlyFire: true,
        ignoresWalls: true,
        color: '#881337',
        life: 2.5,
        maxLife: 2.5,
        pierce: 99,
        isWave: true,
        isBlackDragon: true,
        segments: [{ x: startX, y: startY }],
        bouncesLeft: 0,
        distanceTraveled: 0,
        maxDistance: 1500,
        targetHitCooldowns: {},
        hitIds: new Set(),
      });
      return;
    }

    // shadow_vortex_dragon
    const ptr = casterId === 'player' ? this.getWorldPointer() : { x: caster.x + Math.cos(aimAngle) * 240, y: caster.y + Math.sin(aimAngle) * 240 };
    const travel = clamp(dist(caster.x, caster.y, ptr.x, ptr.y), 90, 380);
    const tx = clamp(caster.x + Math.cos(aimAngle) * travel, TILE, this.map.width - TILE);
    const ty = clamp(caster.y + Math.sin(aimAngle) * travel, TILE, this.map.height - TILE);
    const vortexLife = 3.5 + ultRank * 0.35;
    this.addSkillTrace('blink', caster, { x: tx, y: ty }, 0.45);
    this.siege.zones.push({
      id: uid('vortex'),
      kind: 'vortex',
      faction: fac,
      ownerId: casterId,
      x: tx,
      y: ty,
      radius: 135 + ultRank * 14,
      life: vortexLife,
      maxLife: vortexLife,
      tickTimer: 0.1,
      damage: Math.round(16 * ultMult),
    });
  }

  public damageSiegeStructure(
    st: SiegeStructure,
    rawDmg: number,
    attackerId: string,
    attackerFaction: FactionId
  ): number {
    if (!this.siege || !st.alive || st.faction === attackerFaction || rawDmg <= 0) return 0;
    if (st.invulnerable) {
      if (st.hitFlash <= 0) {
        st.hitFlash = 0.25;
        this.spawnText(
          st.x,
          st.y - st.radius - 16,
          st.kind === 'castle' ? '主堡無敵! 先拆高地塔' : '高地塔無敵! 先拆外塔',
          '#38BDF8',
          0.9,
          true
        );
      }
      return 0;
    }

    let dmg = rawDmg;
    if (st.backdoorProtected) dmg *= SIEGE_CONFIG.backdoorDamageMult;
    if (this.siege.suddenDeath) dmg *= SIEGE_CONFIG.suddenDeathStructureDmgMult;

    if (attackerFaction === 'royal' || attackerFaction === 'shadow') {
      const buffs = this.siege.teamBuffs[attackerFaction];
      dmg *= 1 + buffs.vanguardStacks * 0.1 + (buffs.baronTimer > 0 ? 0.25 : 0);
    }
    const heroState = this.getSiegeHeroState(attackerId);
    if (heroState) {
      dmg *= 1 + (heroState.upgrades.firepower ?? 0) * 0.15;
    }

    const finalDmg = Math.max(1, Math.round(dmg));
    st.hp = Math.max(0, st.hp - finalDmg);
    st.hitFlash = 0.1;

    if (attackerId === 'player') {
      this.player.totalDamage += finalDmg;
      this.player.score += finalDmg;
    } else {
      const rt = this.getRemoteHumanByEntityId(attackerId);
      if (rt) {
        rt.totalDamage += finalDmg;
        rt.score += finalDmg;
      }
    }

    this.spawnBurst(st.x, st.y, '#FBBF24', 4);
    if (st.hp > 0) return finalDmg;

    st.alive = false;
    this.spawnBurst(st.x, st.y, st.faction === 'royal' ? '#38BDF8' : '#C026D3', 28);
    sfx.ultimate();
    refreshStructureInvulnerability(this.siege.structures);

    const killerFac: SiegeFactionId = attackerFaction === 'shadow' ? 'shadow' : 'royal';
    this.awardSiegeTeamGold(killerFac, 60);
    this.awardSiegeHeroKill(attackerId, 150, 120, false, true);

    if (st.kind === 'castle') {
      const playerWon = st.faction !== this.player.faction;
      this.status = playerWon ? 'VICTORY' : 'GAME_OVER';
      if (playerWon) sfx.victory();
      else sfx.defeat();
      this.showBanner(
        st.faction === 'royal' ? '天影十字軍摧毀皇家主城堡！' : '皇家騎士團摧毀天影主城堡！',
        5.0
      );
      this.clearInputs();
      this.emitHud();
    } else {
      const label = st.kind === 'inner_tower' ? '高地防禦塔' : '外防禦塔';
      this.showBanner(`${FACTIONS[killerFac].name} 摧毀了${FACTIONS[st.faction].name}${label}！`, 3.5);
    }
    return finalDmg;
  }

  private handleSiegeEnemyRemoved(enemy: EnemyEntity, attackerId?: string) {
    if (!this.siege) return;
    if (enemy.siegeUnitKind === 'hero' && !enemy.isHumanPlayer) {
      const fac: SiegeFactionId = enemy.faction === 'shadow' ? 'shadow' : 'royal';
      const respSec = computeSiegeRespawnSeconds(this.siege.matchTime, this.siege.suddenDeath);
      this.siege.aiRespawns.push({
        name: enemy.name,
        skinId: enemy.characterSkin.id,
        faction: fac,
        lane: enemy.siegeLane ?? 'mid',
        loadout: enemy.siegeLoadout ?? getDefaultSiegeLoadout(fac, enemy.characterSkin.id),
        timer: respSec,
        deaths: (enemy.siegeDeaths ?? 0) + 1,
        gold: enemy.siegeGold ?? 120,
        upgrades: enemy.siegeUpgrades ?? { firepower: 0, blade: 0, armor: 0, core: 0 },
      });
      if (attackerId) this.awardSiegeHeroKill(attackerId, 150, 130, true);
      return;
    }

    if (enemy.siegeUnitKind === 'minion' || enemy.siegeUnitKind === 'super_minion') {
      const isSuper = enemy.siegeUnitKind === 'super_minion';
      if (attackerId) this.awardSiegeHeroKill(attackerId, isSuper ? 32 : 18, isSuper ? 35 : 22, false, false, true);
      return;
    }

    if (enemy.siegeUnitKind === 'jungle') {
      const camp = this.siege.spec.jungleCamps.find((c) => enemy.id.startsWith(`${c.id}_`));
      if (camp) this.siege.jungleTimers[camp.id] = SIEGE_CONFIG.jungleRespawnSec;
      if (attackerId) {
        this.awardSiegeHeroKill(attackerId, camp?.goldReward ?? 45, camp?.xpReward ?? 55, false, false, true);
        if (attackerId === 'player' && this.player.hp > 0) {
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + 15);
          this.player.qi = Math.min(this.player.maxQi, this.player.qi + 25);
        } else {
          const ae = this.enemies.find((x) => x.id === attackerId);
          if (ae && ae.hp > 0) {
            ae.hp = Math.min(ae.maxHp, ae.hp + 15);
            ae.qi = Math.min(ae.maxQi, ae.qi + 25);
          }
        }
      }
      return;
    }

    if (enemy.siegeUnitKind === 'boss') {
      const killerActor = attackerId === 'player' ? this.player : this.enemies.find((x) => x.id === attackerId);
      const killerFac: SiegeFactionId = killerActor?.faction === 'shadow' ? 'shadow' : 'royal';
      if (enemy.siegeBossKind === 'baron') {
        this.siege.baronState = 'countdown';
        this.siege.baronTimer = SIEGE_CONFIG.baronRespawnSec;
        this.siege.teamBuffs[killerFac].baronTimer = SIEGE_CONFIG.baronBuffDurationSec;
        this.awardSiegeTeamGold(killerFac, 200);
        this.showBanner(`【傭兵血契】${FACTIONS[killerFac].name} 擊殺狂戰巨神！獲得 90 秒全隊吸血與攻城強化！`, 4.5);
      } else {
        this.siege.vanguardState = 'countdown';
        this.siege.vanguardTimer = SIEGE_CONFIG.vanguardRespawnSec;
        this.siege.teamBuffs[killerFac].vanguardStacks += 1;
        this.awardSiegeTeamGold(killerFac, 100);
        this.spawnSiegeVanguardAlly(killerFac);
        this.showBanner(`【幻沙先鋒歸順】${FACTIONS[killerFac].name} 召喚中路攻城先鋒！`, 4.0);
      }
    }
  }

  private awardSiegeTeamGold(faction: SiegeFactionId, gold: number) {
    if (!this.siege) return;
    if (this.player.faction === faction) {
      grantSiegeXpAndGold(this.siege.playerState, gold, 0);
    }
    for (const [peerId, st] of this.siege.remoteStates.entries()) {
      const rt = this.remoteHumans.get(peerId);
      if (rt?.faction === faction) grantSiegeXpAndGold(st, gold, 0);
    }
    for (const e of this.enemies) {
      if (e.siegeUnitKind === 'hero' && !e.isHumanPlayer && e.faction === faction) {
        e.siegeGold = (e.siegeGold ?? 120) + gold;
      }
    }
  }

  private awardSiegeHeroKill(
    attackerId: string,
    gold: number,
    xp: number,
    isHeroKill: boolean,
    isTowerKill = false,
    isCreepKill = false
  ) {
    if (!this.siege) return;
    if (attackerId === 'player') {
      const ps = this.siege.playerState;
      const res = grantSiegeXpAndGold(ps, gold, xp);
      if (isTowerKill) ps.towerKills += 1;
      if (isCreepKill) ps.minionKills += 1;
      if (ps.loadout.passiveId === 'shadow_assassin' && (isHeroKill || isCreepKill)) {
        this.player.qi = Math.min(this.player.maxQi, this.player.qi + 18);
      }
      if (isHeroKill || isCreepKill) {
        this.player.reserveAmmo = Math.min(this.player.maxReserveAmmo, this.player.reserveAmmo + 6);
      }
      if (res.leveledUp) {
        this.player.maxHp = computeSiegeMaxHp(ps);
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + res.hpGain + 20);
        const defPart = res.defenseGain > 0 ? ` 防禦+${res.defenseGain}` : '';
        this.spawnText(
          this.player.x,
          this.player.y - 44,
          `升級 Lv.${res.newLevel}! 血量上限 ${Math.round(this.player.maxHp)} (+${res.hpGain})${defPart}`,
          '#FACC15',
          1.25
        );
        if (res.oldLevel < SIEGE_CONFIG.tacticalUnlockLevel && res.newLevel >= SIEGE_CONFIG.tacticalUnlockLevel) {
          this.showBanner(
            `【Lv.${SIEGE_CONFIG.tacticalUnlockLevel} 解鎖】戰術技「${getTacticalMeta(ps.loadout.tacticalId).name}」已啟用（按 [E] 或右鍵施放）！`,
            3.2
          );
        } else if (res.oldLevel < SIEGE_CONFIG.ultimateUnlockLevel && res.newLevel >= SIEGE_CONFIG.ultimateUnlockLevel) {
          this.showBanner(
            `【Lv.${SIEGE_CONFIG.ultimateUnlockLevel} 解鎖】終極大招「${getUltimateMeta(ps.loadout.ultimateId).name}」已啟用！按 [Q] 切近戰滿氣長按左鍵釋放！`,
            4.0
          );
        }
        this.emitHud();
      }
      return;
    }
    const rPeer = this.getRemoteHumanByEntityId(attackerId);
    if (rPeer) {
      const rState = this.siege.remoteStates.get(rPeer.peerId);
      if (rState) {
        const res = grantSiegeXpAndGold(rState, gold, xp);
        if (isTowerKill) rState.towerKills += 1;
        if (isCreepKill) rState.minionKills += 1;
        if (isHeroKill || isCreepKill) {
          rPeer.reserveAmmo = Math.min(rPeer.maxReserveAmmo, rPeer.reserveAmmo + 6);
        }
        const ent = this.enemies.find((e) => e.id === attackerId);
        if (ent && res.leveledUp) {
          ent.maxHp = computeSiegeMaxHp(rState);
          ent.hp = Math.min(ent.maxHp, ent.hp + res.hpGain + 20);
        }
      }
      return;
    }
    const aiHero = this.enemies.find((e) => e.id === attackerId && e.siegeUnitKind === 'hero');
    if (aiHero) {
      aiHero.siegeGold = (aiHero.siegeGold ?? 120) + gold;
    }
  }

  private getSiegeHeroState(entityId?: string): SiegeHeroState | undefined {
    if (!this.siege || !entityId) return undefined;
    if (entityId === 'player') return this.siege.playerState;
    const rt = this.getRemoteHumanByEntityId(entityId);
    if (rt) return this.siege.remoteStates.get(rt.peerId);
    return undefined;
  }

  private getSiegeMinionDamageMult(e: EnemyEntity): number {
    if (!this.siege) return 1;
    let mult = 1;
    const fac = e.faction === 'shadow' ? 'shadow' : 'royal';
    if (this.siege.teamBuffs[fac].baronTimer > 0) mult += 0.35;
    if (
      this.siege.playerState.loadout.passiveId === 'royal_vanguard_aura' &&
      this.player.faction === fac &&
      this.player.hp > 0 &&
      dist(this.player.x, this.player.y, e.x, e.y) <= 240
    ) {
      mult += 0.2;
    }
    return mult;
  }

  private isInSanctuaryZone(x: number, y: number, faction: FactionId): boolean {
    if (!this.siege) return false;
    return this.siege.zones.some((z) => z.kind === 'sanctuary' && z.faction === faction && dist(x, y, z.x, z.y) <= z.radius);
  }

  private isInsideOwnFountain(x: number, y: number, faction: SiegeFactionId): boolean {
    if (!this.siege) return false;
    const f = this.siege.spec.fountains[faction];
    return dist(x, y, f.x, f.y) <= f.radius;
  }

  private notifySiegeTurretHeroAggro(attackerId: string, victim: EnemyEntity) {
    if (!this.siege) return;
    for (const st of this.siege.structures) {
      if (!st.alive || st.faction !== victim.faction) continue;
      if (dist(st.x, st.y, victim.x, victim.y) <= st.range) {
        st.aggroTargetId = attackerId;
        st.aggroLockTimer = 3.0;
      }
    }
  }

  private updateSiegeMode(dt: number) {
    const sg = this.siege;
    if (!sg) return;

    sg.matchTime += dt;
    if (!sg.suddenDeath && sg.matchTime >= sg.matchDuration - SIEGE_CONFIG.suddenDeathLeadSec) {
      sg.suddenDeath = true;
      if (!sg.suddenDeathAnnounced) {
        sg.suddenDeathAnnounced = true;
        this.showBanner('【總攻時刻！】最後 3 分鐘雙倍超級兵加速推進，所有建築護甲下降！', 4.5);
      }
    }

    if (sg.matchTime >= sg.matchDuration && this.status === 'PLAYING') {
      const rCastle = sg.structures.find((s) => s.id === 'royal_castle');
      const sCastle = sg.structures.find((s) => s.id === 'shadow_castle');
      const rPct = rCastle ? rCastle.hp / rCastle.maxHp : 0;
      const sPct = sCastle ? sCastle.hp / sCastle.maxHp : 0;
      const pFac: SiegeFactionId = this.player.faction === 'shadow' ? 'shadow' : 'royal';
      const playerWon = pFac === 'royal' ? rPct >= sPct : sPct >= rPct;
      this.status = playerWon ? 'VICTORY' : 'GAME_OVER';
      if (playerWon) sfx.victory();
      else sfx.defeat();
      this.showBanner(`時間到！依主城堡血量判定：${playerWon ? '勝利' : '敗北'}`, 5.0);
      this.clearInputs();
      this.emitHud();
      return;
    }

    sg.teamBuffs.royal.baronTimer = Math.max(0, sg.teamBuffs.royal.baronTimer - dt);
    sg.teamBuffs.shadow.baronTimer = Math.max(0, sg.teamBuffs.shadow.baronTimer - dt);

    sg.passiveGoldTimer += dt;
    if (sg.passiveGoldTimer >= 1.0) {
      sg.passiveGoldTimer -= 1.0;
      this.awardSiegeTeamGold('royal', SIEGE_CONFIG.passiveGoldPerSec);
      this.awardSiegeTeamGold('shadow', SIEGE_CONFIG.passiveGoldPerSec);
    }

    // Player siege timers, fountain heal, out-of-combat ammo regen, & recall
    const ps = sg.playerState;
    ps.tacticalCd = Math.max(0, ps.tacticalCd - dt);
    ps.aegisReflectTimer = Math.max(0, ps.aegisReflectTimer - dt);
    ps.smokeSpeedTimer = Math.max(0, ps.smokeSpeedTimer - dt);
    ps.markedTimer = Math.max(0, ps.markedTimer - dt);
    ps.outOfCombatTimer += dt;

    const p = this.player;
    const pFac: SiegeFactionId = p.faction === 'shadow' ? 'shadow' : 'royal';
    if (p.hp > 0) {
      if (this.isInsideOwnFountain(p.x, p.y, pFac)) {
        p.hp = Math.min(p.maxHp, p.hp + SIEGE_CONFIG.fountainHealPerSec * dt);
        if (!p.chargingMelee && !p.chargeReady && !this.chargeSessionAllowed) {
          p.qi = Math.min(p.maxQi, p.qi + 15 * dt);
        }
        p.reserveAmmo = p.maxReserveAmmo;
        for (const w of p.weapons) {
          if (w.type === 'gun' && w.reloadTimer <= 0) w.ammoInMag = w.def.magSize;
        }
      } else if (ps.outOfCombatTimer >= SIEGE_CONFIG.outOfCombatAmmoDelaySec) {
        p.reserveAmmo = Math.min(p.maxReserveAmmo, p.reserveAmmo + SIEGE_CONFIG.outOfCombatAmmoPerSec * dt);
      }

      if (ps.recallTimer > 0) {
        ps.recallTimer = Math.max(0, ps.recallTimer - dt);
        if (ps.recallTimer === 0) {
          const f = sg.spec.fountains[pFac];
          p.x = f.x;
          p.y = f.y;
          p.elevation = this.getWalkableElevation(p.x, p.y);
          this.spawnBurst(p.x, p.y, '#38BDF8', 16);
          this.spawnText(p.x, p.y - 36, '回城完成!', '#38BDF8', 1.1);
        }
      }
    }

    // Remote human timers & fountain heal
    for (const [peerId, rState] of sg.remoteStates.entries()) {
      rState.tacticalCd = Math.max(0, rState.tacticalCd - dt);
      rState.aegisReflectTimer = Math.max(0, rState.aegisReflectTimer - dt);
      rState.smokeSpeedTimer = Math.max(0, rState.smokeSpeedTimer - dt);
      rState.markedTimer = Math.max(0, rState.markedTimer - dt);
      rState.outOfCombatTimer += dt;
      const rt = this.remoteHumans.get(peerId);
      const ent = this.enemies.find((e) => e.peerId === peerId);
      if (rt && ent && ent.hp > 0) {
        const rFac: SiegeFactionId = ent.faction === 'shadow' ? 'shadow' : 'royal';
        if (this.isInsideOwnFountain(ent.x, ent.y, rFac)) {
          ent.hp = Math.min(ent.maxHp, ent.hp + SIEGE_CONFIG.fountainHealPerSec * dt);
          rt.reserveAmmo = rt.maxReserveAmmo;
          for (const w of ent.weapons) {
            if (w.type === 'gun' && w.reloadTimer <= 0) w.ammoInMag = w.def.magSize;
          }
        } else if (rState.outOfCombatTimer >= SIEGE_CONFIG.outOfCombatAmmoDelaySec) {
          rt.reserveAmmo = Math.min(rt.maxReserveAmmo, rt.reserveAmmo + SIEGE_CONFIG.outOfCombatAmmoPerSec * dt);
        }
        if (rState.recallTimer > 0) {
          rState.recallTimer = Math.max(0, rState.recallTimer - dt);
          if (rState.recallTimer === 0) {
            const f = sg.spec.fountains[rFac];
            ent.x = f.x;
            ent.y = f.y;
            ent.elevation = this.getWalkableElevation(ent.x, ent.y);
            this.spawnBurst(ent.x, ent.y, '#38BDF8', 14);
          }
        }
      }
    }

    // AI Heroes fountain heal, level sync & upgrades
    for (const e of this.enemies) {
      if (e.siegeUnitKind === 'hero' && !e.isHumanPlayer) {
        const eFac: SiegeFactionId = e.faction === 'shadow' ? 'shadow' : 'royal';
        const targetAiLvl = Math.min(10, 1 + Math.floor(sg.matchTime / 95) + Math.floor((e.siegeGold ?? 120) / 360));
        if ((e.siegeLevel ?? 1) < targetAiLvl) {
          const prevMax = e.maxHp;
          e.siegeLevel = targetAiLvl;
          const nextMax = computeSiegeMaxHp({
            level: targetAiLvl,
            upgrades: e.siegeUpgrades ?? { firepower: 0, blade: 0, armor: 0, core: 0 },
            loadout: e.siegeLoadout ?? getDefaultSiegeLoadout(eFac, e.characterSkin.id),
          });
          e.maxHp = nextMax;
          e.hp = Math.min(nextMax, e.hp + Math.max(0, nextMax - prevMax));
        }
        if (this.isInsideOwnFountain(e.x, e.y, eFac)) {
          e.hp = Math.min(e.maxHp, e.hp + SIEGE_CONFIG.fountainHealPerSec * dt);
          const gold = e.siegeGold ?? 0;
          const upg = e.siegeUpgrades ?? { firepower: 0, blade: 0, armor: 0, core: 0 };
          const tracks: SiegeUpgradeTrack[] = ['firepower', 'armor', 'blade', 'core'];
          for (const tr of tracks) {
            const cur = upg[tr] ?? 0;
            const cost = SIEGE_UPGRADES.find((u) => u.track === tr)?.costs[cur];
            if (cur < 5 && cost !== undefined && gold >= cost) {
              e.siegeGold = gold - cost;
              upg[tr] = cur + 1;
              e.siegeUpgrades = upg;
              if (tr === 'armor') {
                const nextMax = computeSiegeMaxHp({
                  level: e.siegeLevel ?? 1,
                  upgrades: upg,
                  loadout: e.siegeLoadout ?? getDefaultSiegeLoadout(eFac, e.characterSkin.id),
                });
                const gain = Math.max(32, nextMax - e.maxHp);
                e.maxHp = nextMax;
                e.hp = Math.min(e.maxHp, e.hp + gain);
              }
              break;
            }
          }
        }
      }
      // Baron periodic giant/vampire frenzy
      if (e.siegeUnitKind === 'boss' && e.siegeBossKind === 'baron' && e.hp < e.maxHp * 0.65) {
        if (e.giantTimer <= 0) {
          e.giantTimer = 6.0;
          e.vampireTimer = 6.0;
        }
      }
      // Jungle / Boss leash healing when out of combat at home
      if ((e.siegeUnitKind === 'jungle' || e.siegeUnitKind === 'boss') && e.siegeHomePos && !e.focusedTargetId) {
        if (dist(e.x, e.y, e.siegeHomePos.x, e.siegeHomePos.y) < 48 && e.hp < e.maxHp) {
          e.hp = Math.min(e.maxHp, e.hp + 12 * dt);
        }
      }
    }

    // Minion waves
    sg.waveTimer -= dt;
    if (sg.waveTimer <= 0) {
      sg.waveTimer = sg.suddenDeath ? SIEGE_CONFIG.suddenDeathWaveIntervalSec : SIEGE_CONFIG.waveIntervalSec;
      this.spawnSiegeMinionWave();
    }

    // Jungle camps
    for (const camp of sg.spec.jungleCamps) {
      const aliveUnit = this.enemies.some((e) => e.id.startsWith(`${camp.id}_`));
      if (!aliveUnit) {
        sg.jungleTimers[camp.id] = Math.max(0, (sg.jungleTimers[camp.id] ?? 0) - dt);
        if (sg.jungleTimers[camp.id] === 0) {
          this.spawnSiegeJungleUnit(camp.id);
        }
      }
    }

    // Bosses
    if (sg.vanguardState === 'countdown') {
      sg.vanguardTimer = Math.max(0, sg.vanguardTimer - dt);
      if (sg.vanguardTimer === 0) this.spawnSiegeBoss('vanguard');
    }
    if (sg.baronState === 'countdown') {
      sg.baronTimer = Math.max(0, sg.baronTimer - dt);
      if (sg.baronTimer === 0) this.spawnSiegeBoss('baron');
    }

    // AI hero respawns
    for (let i = sg.aiRespawns.length - 1; i >= 0; i--) {
      const item = sg.aiRespawns[i];
      item.timer -= dt;
      if (item.timer <= 0) {
        sg.aiRespawns.splice(i, 1);
        this.enemies.push(
          this.spawnSiegeHero(item.faction, item.skinId, item.loadout, item.lane, item.name, item.gold, item.upgrades, item.deaths)
        );
      }
    }

    this.updateSiegeZones(dt);
    this.updateSiegeStructures(dt);
  }

  private updateSiegeZones(dt: number) {
    if (!this.siege) return;
    const nextZones = [];
    for (const z of this.siege.zones) {
      z.life -= dt;
      if (z.life <= 0) {
        if (z.kind === 'decoy') {
          const dmg = z.damage ?? 38;
          this.spawnBurst(z.x, z.y, '#C084FC', 18);
          this.pushSlash({
            x: z.x,
            y: z.y,
            angle: 0,
            arc: Math.PI * 2,
            reach: z.radius,
            color: '#C084FC',
            life: 0.25,
            maxLife: 0.25,
            isUltimate: true,
            style: 'sweep',
          });
          if (z.ownerId !== 'player' && this.player.hp > 0 && this.player.faction !== z.faction && dist(z.x, z.y, this.player.x, this.player.y) <= z.radius + this.player.radius) {
            this.damagePlayer(dmg, true, z.ownerId, z.x, z.y);
          }
          for (const e of [...this.enemies]) {
            if (e.faction !== z.faction && dist(z.x, z.y, e.x, e.y) <= z.radius + e.radius) {
              this.damageEnemy(e, dmg, true, 0, 0, false, true, z.ownerId, z.faction, z.x, z.y);
              if (e.hp > 0) e.stunTimer = Math.max(e.stunTimer, 0.5);
            }
          }
        }
        continue;
      }

      z.tickTimer -= dt;
      if (z.tickTimer <= 0) {
        if (z.kind === 'sanctuary') {
          z.tickTimer = 0.5;
          const heal = z.heal ?? 7;
          if (this.player.hp > 0 && this.player.faction === z.faction && dist(z.x, z.y, this.player.x, this.player.y) <= z.radius) {
            this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
          }
          for (const e of this.enemies) {
            if (e.faction === z.faction && dist(z.x, z.y, e.x, e.y) <= z.radius) {
              e.hp = Math.min(e.maxHp, e.hp + heal);
            }
          }
        } else if (z.kind === 'vortex') {
          z.tickTimer = 0.45;
          const dmg = z.damage ?? 16;
          if (z.ownerId !== 'player' && this.player.hp > 0 && this.player.faction !== z.faction && dist(z.x, z.y, this.player.x, this.player.y) <= z.radius + this.player.radius) {
            this.damagePlayer(dmg, true, z.ownerId, z.x, z.y);
          }
          for (const e of [...this.enemies]) {
            if (e.faction !== z.faction && dist(z.x, z.y, e.x, e.y) <= z.radius + e.radius) {
              this.damageEnemy(e, dmg, true, 0, 0, false, true, z.ownerId, z.faction, z.x, z.y);
            }
          }
          for (const st of this.siege.structures) {
            if (st.alive && st.faction !== z.faction && dist(z.x, z.y, st.x, st.y) <= z.radius + st.radius) {
              this.damageSiegeStructure(st, dmg, z.ownerId, z.faction);
            }
          }
        }
      }
      nextZones.push(z);
    }
    this.siege.zones = nextZones;
  }

  private updateSiegeStructures(dt: number) {
    if (!this.siege) return;
    const p = this.player;

    for (const st of this.siege.structures) {
      if (!st.alive) continue;
      st.hitFlash = Math.max(0, st.hitFlash - dt);
      st.aggroLockTimer = Math.max(0, st.aggroLockTimer - dt);
      st.fireCooldown = Math.max(0, st.fireCooldown - dt);

      const oppFac: SiegeFactionId = st.faction === 'royal' ? 'shadow' : 'royal';
      const hasMinionNearby = this.enemies.some(
        (e) =>
          e.faction === oppFac &&
          (e.siegeUnitKind === 'minion' || e.siegeUnitKind === 'super_minion' || e.siegeUnitKind === 'vanguard_ally') &&
          dist(st.x, st.y, e.x, e.y) <= SIEGE_CONFIG.backdoorRadiusPx
      );
      st.backdoorProtected = !hasMinionNearby;

      // Validate locked aggro
      if (st.aggroTargetId) {
        const lockedPos =
          st.aggroTargetId === 'player'
            ? p.hp > 0
              ? { x: p.x, y: p.y }
              : null
            : (() => {
                const te = this.enemies.find((e) => e.id === st.aggroTargetId && e.hp > 0);
                return te ? { x: te.x, y: te.y } : null;
              })();
        if (!lockedPos || dist(st.x, st.y, lockedPos.x, lockedPos.y) > st.range || st.aggroLockTimer <= 0) {
          st.aggroTargetId = null;
        }
      }

      if (!st.aggroTargetId) {
        const minionsInRange = this.enemies
          .filter(
            (e) =>
              e.faction === oppFac &&
              (e.siegeUnitKind === 'minion' || e.siegeUnitKind === 'super_minion' || e.siegeUnitKind === 'vanguard_ally') &&
              dist(st.x, st.y, e.x, e.y) <= st.range
          )
          .sort((a, b) => dist(st.x, st.y, a.x, a.y) - dist(st.x, st.y, b.x, b.y));
        if (minionsInRange.length > 0) {
          st.aggroTargetId = minionsInRange[0].id;
        } else {
          const heroesInRange: { id: string; d: number }[] = [];
          if (p.hp > 0 && p.faction === oppFac && dist(st.x, st.y, p.x, p.y) <= st.range) {
            heroesInRange.push({ id: 'player', d: dist(st.x, st.y, p.x, p.y) });
          }
          for (const e of this.enemies) {
            if (e.faction === oppFac && e.hp > 0 && dist(st.x, st.y, e.x, e.y) <= st.range) {
              heroesInRange.push({ id: e.id, d: dist(st.x, st.y, e.x, e.y) });
            }
          }
          heroesInRange.sort((a, b) => a.d - b.d);
          if (heroesInRange.length > 0) st.aggroTargetId = heroesInRange[0].id;
        }
      }

      if (st.aggroTargetId && st.fireCooldown <= 0) {
        st.fireCooldown = st.fireInterval;
        const beamColor = st.faction === 'royal' ? '#38BDF8' : '#C026D3';
        if (st.aggroTargetId === 'player' && p.hp > 0) {
          this.pushBeam({ x1: st.x, y1: st.y - 10, x2: p.x, y2: p.y, color: beamColor, life: 0.16, maxLife: 0.16, width: 3.4 });
          // Turret energy bolts pierce 55% of Royal Shield instead of being 100% immune
          if (p.royalShieldTimer > 0) {
            p.hp -= Math.round(st.damage * 0.55);
            if (p.hp <= 0) this.handlePlayerDeath(`turret_${st.id}`);
          } else {
            this.damagePlayer(st.damage, false, `turret_${st.id}`, st.x, st.y);
          }
        } else {
          const te = this.enemies.find((e) => e.id === st.aggroTargetId && e.hp > 0);
          if (te) {
            this.pushBeam({ x1: st.x, y1: st.y - 10, x2: te.x, y2: te.y, color: beamColor, life: 0.16, maxLife: 0.16, width: 3.4 });
            this.damageEnemy(te, st.damage, false, 0, 0, false, true, `turret_${st.id}`, st.faction, st.x, st.y);
          }
        }
      }
    }
  }

  private findNearestHostileStructureInSight(e: EnemyEntity, maxDist: number): SiegeStructure | null {
    if (!this.siege) return null;
    let best: SiegeStructure | null = null;
    let bestD = maxDist;
    for (const st of this.siege.structures) {
      if (!st.alive || st.invulnerable || st.faction === e.faction) continue;
      const d = dist(e.x, e.y, st.x, st.y) - st.radius;
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    return best;
  }

  private getSiegeAiGoal(e: EnemyEntity): { x: number; y: number } | null {
    if (!this.siege) return null;
    if (e.siegeUnitKind === 'jungle' || e.siegeUnitKind === 'boss') {
      if (e.siegeHomePos && dist(e.x, e.y, e.siegeHomePos.x, e.siegeHomePos.y) > 260) {
        e.focusedTargetId = null;
        return e.siegeHomePos;
      }
      return e.siegeHomePos ?? null;
    }

    const fac: SiegeFactionId = e.faction === 'shadow' ? 'shadow' : 'royal';
    if (e.siegeUnitKind === 'hero' && e.hp < e.maxHp * 0.24) {
      return this.siege.spec.fountains[fac];
    }

    const lane = e.siegeLane ?? 'mid';
    const wps = this.siege.spec.laneWaypoints[lane];
    let idx = e.siegeWaypointIdx ?? (fac === 'royal' ? 0 : wps.length - 1);
    idx = clamp(idx, 0, wps.length - 1);
    const targetWp = wps[idx];
    const nextIdx = fac === 'royal' ? Math.min(wps.length - 1, idx + 1) : Math.max(0, idx - 1);
    const closerToNext =
      nextIdx !== idx &&
      dist(e.x, e.y, wps[nextIdx].x, wps[nextIdx].y) < dist(targetWp.x, targetWp.y, wps[nextIdx].x, wps[nextIdx].y);
    if (dist(e.x, e.y, targetWp.x, targetWp.y) < 110 || closerToNext) {
      idx = nextIdx;
      e.siegeWaypointIdx = idx;
    }

    const oppCastle = this.siege.structures.find((s) => s.faction !== fac && s.kind === 'castle');
    if (
      oppCastle &&
      oppCastle.alive &&
      ((fac === 'royal' && idx === wps.length - 1) || (fac === 'shadow' && idx === 0))
    ) {
      return { x: oppCastle.x, y: oppCastle.y };
    }
    return wps[idx];
  }

  private exportSiegeSnapshot(): NetSiegeSnapshot {
    const sg = this.siege!;
    const players: NetSiegeSnapshot['players'] = [
      {
        peerId: this.multiplayer?.hostPeerId ?? 'host',
        gold: Math.floor(sg.playerState.gold),
        lvl: sg.playerState.level,
        xp: Math.floor(sg.playerState.xp),
        xpNext: sg.playerState.xpToNext,
        upg: { ...sg.playerState.upgrades },
        tacCd: round1(sg.playerState.tacticalCd),
        rec: round1(sg.playerState.recallTimer),
        mk: sg.playerState.minionKills,
        tk: sg.playerState.towerKills,
        deaths: sg.playerState.deaths,
        maxHp: Math.round(this.player.maxHp),
      },
    ];
    for (const [peerId, st] of sg.remoteStates.entries()) {
      const ent = this.enemies.find((e) => e.peerId === peerId);
      players.push({
        peerId,
        gold: Math.floor(st.gold),
        lvl: st.level,
        xp: Math.floor(st.xp),
        xpNext: st.xpToNext,
        upg: { ...st.upgrades },
        tacCd: round1(st.tacticalCd),
        rec: round1(st.recallTimer),
        mk: st.minionKills,
        tk: st.towerKills,
        deaths: st.deaths,
        maxHp: ent ? Math.round(ent.maxHp) : computeSiegeMaxHp(st),
      });
    }
    return {
      matchTime: round1(sg.matchTime),
      matchDuration: sg.matchDuration,
      suddenDeath: sg.suddenDeath,
      vanguardState: sg.vanguardState,
      vanguardSec: Math.ceil(sg.vanguardTimer),
      baronState: sg.baronState,
      baronSec: Math.ceil(sg.baronTimer),
      teamBuffs: {
        royal: { vanguardStacks: sg.teamBuffs.royal.vanguardStacks, baronTimer: round1(sg.teamBuffs.royal.baronTimer) },
        shadow: { vanguardStacks: sg.teamBuffs.shadow.vanguardStacks, baronTimer: round1(sg.teamBuffs.shadow.baronTimer) },
      },
      structures: sg.structures.map((s) => ({
        id: s.id,
        hp: Math.round(s.hp),
        alive: s.alive,
        invuln: s.invulnerable,
        bd: s.backdoorProtected,
        aggro: s.aggroTargetId,
        ...(s.hitFlash > 0 ? { hf: round1(s.hitFlash) } : {}),
      })),
      zones: sg.zones.map((z) => ({
        id: z.id,
        kind: z.kind,
        fac: z.faction,
        x: round1(z.x),
        y: round1(z.y),
        r: z.radius,
        life: round1(z.life),
        maxLife: z.maxLife,
      })),
      players,
    };
  }

  private applySiegeSnapshot(snap: NetSiegeSnapshot, localPeerId?: string) {
    if (!this.siege) return;
    const sg = this.siege;
    sg.matchTime = snap.matchTime;
    sg.matchDuration = snap.matchDuration as typeof sg.matchDuration;
    sg.suddenDeath = snap.suddenDeath;
    sg.vanguardState = snap.vanguardState;
    sg.vanguardTimer = snap.vanguardSec;
    sg.baronState = snap.baronState;
    sg.baronTimer = snap.baronSec;
    sg.teamBuffs = {
      royal: { ...snap.teamBuffs.royal },
      shadow: { ...snap.teamBuffs.shadow },
    };

    const byId = new Map(snap.structures.map((s) => [s.id, s]));
    for (const st of sg.structures) {
      const n = byId.get(st.id);
      if (!n) continue;
      st.hp = n.hp;
      st.alive = n.alive;
      st.invulnerable = n.invuln;
      st.backdoorProtected = n.bd;
      st.aggroTargetId = n.aggro;
      st.hitFlash = n.hf ?? 0;
    }

    sg.zones = snap.zones.map((z) => ({
      id: z.id,
      kind: z.kind,
      faction: z.fac,
      ownerId: '',
      x: z.x,
      y: z.y,
      radius: z.r,
      life: z.life,
      maxLife: z.maxLife,
      tickTimer: 0,
    }));

    const localInfo = localPeerId ? snap.players.find((pl) => pl.peerId === localPeerId) : snap.players[0];
    if (localInfo) {
      sg.playerState.gold = localInfo.gold;
      sg.playerState.level = localInfo.lvl;
      sg.playerState.xp = localInfo.xp;
      sg.playerState.xpToNext = localInfo.xpNext;
      sg.playerState.upgrades = { ...localInfo.upg };
      sg.playerState.tacticalCd = localInfo.tacCd;
      sg.playerState.recallTimer = localInfo.rec;
      sg.playerState.minionKills = localInfo.mk;
      sg.playerState.towerKills = localInfo.tk;
      sg.playerState.deaths = localInfo.deaths;
      this.player.maxHp = localInfo.maxHp;
    }
  }

  private exportSiegeHudState(): SiegeHudState {
    const sg = this.siege!;
    const p = this.player;
    const pFac: SiegeFactionId = p.faction === 'shadow' ? 'shadow' : 'royal';
    const inFountain = p.hp > 0 && this.isInsideOwnFountain(p.x, p.y, pFac);
    const rCastle = sg.structures.find((s) => s.id === 'royal_castle');
    const sCastle = sg.structures.find((s) => s.id === 'shadow_castle');
    const rTowers = sg.structures.filter((s) => s.faction === 'royal' && s.kind !== 'castle' && s.alive).length;
    const sTowers = sg.structures.filter((s) => s.faction === 'shadow' && s.kind !== 'castle' && s.alive).length;

    const zoom = Math.max(0.5, this.camera.zoom);
    const viewW = this.viewport.width / zoom;
    const viewH = this.viewport.height / zoom;
    const clampedCam = this.clampCameraToMap(this.camera.x, this.camera.y, this.viewport.width, this.viewport.height);

    const minimapUnits: SiegeHudState['minimapUnits'] = [];
    if (p.hp > 0) {
      minimapUnits.push({ x: p.x, y: p.y, faction: p.faction, kind: 'player' });
    }
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      const kind: SiegeHudState['minimapUnits'][0]['kind'] =
        e.siegeUnitKind === 'boss'
          ? 'boss'
          : e.siegeUnitKind === 'jungle'
            ? 'jungle'
            : e.siegeUnitKind === 'minion' || e.siegeUnitKind === 'super_minion' || e.siegeUnitKind === 'vanguard_ally'
              ? 'minion'
              : 'hero';
      minimapUnits.push({ x: e.x, y: e.y, faction: e.faction, kind });
    }

    return {
      matchTime: sg.matchTime,
      matchDuration: sg.matchDuration,
      suddenDeath: sg.suddenDeath,
      royalCastleHp: rCastle?.hp ?? 0,
      royalCastleMaxHp: rCastle?.maxHp ?? 4000,
      shadowCastleHp: sCastle?.hp ?? 0,
      shadowCastleMaxHp: sCastle?.maxHp ?? 4000,
      royalTowersAlive: rTowers,
      shadowTowersAlive: sTowers,
      structures: sg.structures.map((s) => ({
        id: s.id,
        faction: s.faction,
        kind: s.kind,
        lane: s.lane,
        x: s.x,
        y: s.y,
        hp: s.hp,
        maxHp: s.maxHp,
        alive: s.alive,
        invulnerable: s.invulnerable,
        backdoorProtected: s.backdoorProtected,
      })),
      vanguardState: sg.vanguardState,
      vanguardSeconds: Math.ceil(sg.vanguardTimer),
      baronState: sg.baronState,
      baronSeconds: Math.ceil(sg.baronTimer),
      playerGold: Math.floor(sg.playerState.gold),
      playerLevel: sg.playerState.level,
      playerDefense: computeSiegeDefense(sg.playerState),
      tacticalUnlocked: sg.playerState.level >= SIEGE_CONFIG.tacticalUnlockLevel,
      ultimateUnlocked: sg.playerState.level >= SIEGE_CONFIG.ultimateUnlockLevel,
      playerXp: Math.floor(sg.playerState.xp),
      playerXpToNext: sg.playerState.xpToNext,
      upgrades: { ...sg.playerState.upgrades },
      inFountain,
      canShop: inFountain || this.status === 'RESPAWNING',
      tacticalCd: sg.playerState.tacticalCd,
      tacticalMaxCd: computeSiegeTacticalCooldown(sg.playerState),
      recallTimer: sg.playerState.recallTimer,
      recallDuration: SIEGE_CONFIG.recallDurationSec,
      loadout: { ...sg.playerState.loadout },
      teamBuffs: {
        royal: { ...sg.teamBuffs.royal },
        shadow: { ...sg.teamBuffs.shadow },
      },
      minionKills: sg.playerState.minionKills,
      towerKills: sg.playerState.towerKills,
      deaths: sg.playerState.deaths,
      mapWidth: this.map.width,
      mapHeight: this.map.height,
      cameraRect: {
        x: clampedCam.x - viewW / 2,
        y: clampedCam.y - viewH / 2,
        w: viewW,
        h: viewH,
      },
      minimapUnits,
    };
  }
}
