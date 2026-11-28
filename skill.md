# 光暈戰記 (Twilight Wars) — 開發與工程規範指南 (`skill.md`)

本文件專注於本專案之 **軟體開發生命週期 (SDLC)、技術架構地圖、遊戲美術設計原則與驗證流程**。所有跨模式通用遊戲規則與特定模式玩法規格已抽離並收錄於 `docs/` 目錄，修改功能前請一併查閱對應規格文件。

---

## 1. 專案概覽、開發流程 (SDLC) 與執行環境

- **技術棧**：React 19、TypeScript、Tailwind CSS v4、HTML5 Canvas 2D、Web Audio API、Vitest、Cloudflare Workers + SQLite Durable Objects (`@cloudflare/vite-plugin` / `wrangler`)。
- **常用開發與驗證指令**：
  - **本地開發伺服器**：`npm run dev`（Port `3000`，同時啟動 Vite HMR 與本地 Durable Objects `workerd`；可設 `DISABLE_HMR` 停用 HMR；Vitest 執行時自動跳過 Cloudflare plugin）。
  - **型別檢查**：`npm run lint`（同時檢查前端 `tsc --noEmit` 與 Worker `tsc -p tsconfig.worker.json --noEmit`）。
  - **自動化測試**：`npm test` 或 `npm test -- --run`（涵蓋引擎物理、AI、塔防與連線協議）。
  - **正式建置與部署**：`npm run build`（輸出至 `dist/client/` 與 Worker build 目錄）；`npm run deploy`（建置並透過 `wrangler deploy` 上線）。
  - **CI 流程**：`.github/workflows/ci.yml` 於 `push` / `pull_request` / `workflow_dispatch` 自動執行 `npm install --no-audit --no-fund --legacy-peer-deps`、`npm run lint`、`npm test`、`npm run build`。
- **本地持久化鍵名 (`localStorage`)**：
  - `twilight_rpg_records_v2`：戰績與戰場紀錄 (`RunRecord[]`)
  - `twilight_rpg_reputations_v2`：三大陣營聲望 (`{ royal: number, shadow: number, mercenary: number }`)
  - `twilight_wars_custom_maps_v1`：自訂戰場資料 (`CustomMapData[]`)
- **UI 與環境守則**：
  - 禁止使用 `window.alert` / `window.open`，一律改用內嵌 Toast 或 Modal。
  - 遊戲對外顯示文案統一採用**繁體中文 (`zh-Hant`)**；保持戰場介面潔淨，不可露出除錯日誌或開發遙測文字。
  - 預先存在之未追蹤資產目錄（如 `public/assets/tiles/`）切勿隨意併入功能 commit。

---

## 2. 程式碼架構地圖

| 檔案路徑 | 核心職責 |
| --- | --- |
| `src/App.tsx` | 頂層視圖路由（大廳 / 整裝室 / 塔防選角 / 戰場 / 地圖編輯器 / 多人大廳），管理 `RunRecord[]`、聲望與 `CustomMapData[]`。 |
| `src/components/PortalView.tsx` | 遊戲主入口（經典三陣營三角選區、三路城堡攻防戰入口、多人連線對戰、創建地圖與即時視覺化手冊）。 |
| `src/components/FactionRoomView.tsx` | 經典模式出戰整裝室（造型、難度、內建／自訂地圖選擇、聲望總覽）。 |
| `src/components/SiegeSetupView.tsx` | 三路城堡攻防戰單頁雙欄選角介面（綁定英雄、武器與戰技／大招／被動天賦一覽）。 |
| `src/components/MultiplayerLobbyView.tsx` | Cloudflare Edge 多人連線作戰室（6 位房號／邀請連結／通行密碼、最多 8 人選角與綁定 Hero Kit 預覽、模式與局時同步）。 |
| `src/components/GameCanvasView.tsx` | `requestAnimationFrame` 主迴圈、`4:3` 戰場視窗、鍵鼠輸入、多人輸入同步、近戰隱藏準星切換、經典雙環／右上雙手 HUD 與塔防底部 MOBA 主控台。 |
| `src/components/SiegeMinimap.tsx` | 三路城堡攻防戰專用即時戰術小地圖元件。 |
| `src/components/MapEditorView.tsx` | 無捲軸 `WASD` 自訂戰場編輯器（地板／地形／物件／出生物資與 WYSIWYG 合法性預覽）。 |
| `src/components/MiniMapPreview.tsx` | 內建與自訂戰場之即時 Canvas 縮圖與縮放預覽。 |
| `src/components/WeaponArt.tsx` | 武器、角色頭像、陣營徽章與技能圖示之 SVG 元件。 |
| `src/game/types.ts` | 全域核心型別（陣營、雙手武器、人物／AI 實體、正交地圖結構、塔防狀態與 `HudSnapshot`）。 |
| `src/game/data.ts` | 經典陣營設定、角色皮膚目錄、8 張內建戰場目錄、`GUNS`、`MELEES` 與聲望倍率。 |
| `src/game/siegeData.ts` | 三路城堡攻防戰英雄綁定套裝 (`SIEGE_HERO_PRESETS`)、戰技／大招／被動、4 條升級曲線與 `SIEGE_CONFIG`。 |
| `src/game/tuning.ts` | 手感與平衡常數（移動、準心擴散、裝彈節奏、AI 瞄準轉速與節奏倍率）。 |
| `src/game/geometry.ts` | 數學、8 方向鎖定、碰撞與射線相交原語、`areHostile` 與角色半徑常數。 |
| `src/game/maps.ts` & `src/game/siegeMap.ts` | 經典 8 大戰場與三路城堡攻防戰專屬三路峽谷地圖建構器。 |
| `src/game/customMaps.ts` | 自訂地圖驗證器（`FLOOR_TERRAIN_BINDINGS`、階梯貼合、跨格等高與三方 BFS 連通性）。 |
| `src/game/mapRenderer.ts` & `src/game/siegeRenderer.ts` | 2.5D 分層地形／物件／冰雪機關渲染管線，與防禦塔／主堡／兵線／野怪建築繪製。 |
| `src/game/combatRenderer.ts` & `src/game/skillRenderer.ts` | 角色持武姿態、武器造型、揮砍刀光、技能特效、粒子與 `CyrBit` 扣減飄字渲染。 |
| `src/game/engine.ts` & `src/game/siegeHelpers.ts` | `TwilightEngine` 核心模擬引擎（A*、純高度物理、雙模式戰鬥與技能循環、AI 決策、經濟／兵線／Boss 輔助邏輯）。 |
| `src/net/protocol.ts` & `src/net/transport.ts` | 前後端多人連線封包協定與 WebSocket 傳輸層（含 RTT 與安全斷線）。 |
| `worker/index.ts` & `wrangler.jsonc` | Cloudflare Workers 入口與 `GameRoom` Durable Object（WebSocket Hibernation、模式／陣營強制校正、房務清理 Alarm）。 |
| `src/audio/sfx.ts` | Web Audio API 實錄音效樣本引擎 (`sfx`，讀取 `public/assets/audio/` CC0 音檔，來源與授權記錄於 `public/assets/audio/credits.txt`)。 |
| `src/game/engine.test.ts`, `src/game/siege.test.ts`, `src/net/protocol.test.ts` | Vitest 自動化測試套件（引擎物理與經典規則、三路城堡攻防戰、網路協定）。 |

---

## 3. 遊戲規格文件索引 (`docs/`)

開發時請依修改範圍查閱對應規格文件，**切勿將遊戲玩法細節或單一模式數值混寫回 `skill.md`**：

- **[遊戲通用知識與核心系統 (`docs/general-knowledge.md`)](./docs/general-knowledge.md)**：世界觀、操作按鍵、HUD 飄字、統一雙手武器模型 (`[0, 1]`)、純高度 2.5D 物理、正交三層地圖與特殊機關、自訂地圖創作器、多人連線共通機制。
- **[經典混戰模式規格 (`docs/modes/classic-pvp.md`)](./docs/modes/classic-pvp.md)**：三方陣營規則、10 兵出戰名額與玩家 3 命保留、陣營聲望倍率、備彈差異、近戰集氣 9+3 技能、AI 高地／單向掩體戰術與 8 張經典戰場。
- **[三路城堡攻防戰模式規格 (`docs/modes/siege.md`)](./docs/modes/siege.md)**：5v5 雙陣營限制、10 位英雄固定套裝表、Lv.2 戰技／Lv.4 大招／被動天賦、金幣經濟與 `[3]`–`[6]` 升級曲線、慢回彈設計、兵線／野怪／Boss 時間軸及塔防 HUD 規範。

> **文件同步維護規則**：每當更動武器手感、物理判定、地圖編輯器或特定模式規則時，務必同步更新 `docs/` 內對應文件，保持文件與程式碼一致。

---

## 4. 遊戲美術設計規範 (Game Art Design Guidelines)

進行任何角色、武器、技能特效、地形物件或介面視覺美術調整時，所有 Agent 必須嚴格遵守以下設計原則：

1. **核心風格參照：《光暈戰記》(Twilight Wars) 原作視覺語言**
   - 保持 2D 俯視角（2.5D）經典 Flash／賽璐珞動漫美術風格：**鮮明粗黑外框線 (`#020617`)、清晰分明的金屬／材質漸層色塊、自然的角色武器持握比例與戰場高可讀性**，令武器、角色動作與技能特效風格高度一致。
2. **善用圖片生成能力 — 先蒐集線上／原作參考圖再生成**
   - 當環境具備 Image Generation 能力時，**嚴禁憑空盲目生成或直接套用未經核對的美術草稿**。
   - 正確流程：**先蒐集／對照原版《光暈戰記》或同風格的線上參考圖片（Reference Images）**，明確定義武器外型細節、握持位置、朝向與動畫方向後，生成設計方案預覽圖或分鏡供使用者審閱；經使用者確認選定風格後，再落實進遊戲實作。
3. **無圖片生成或需精緻貼圖時 — 優先選用無版權開源素材**
   - 若無法使用圖片生成，或需要更高細緻度的地板、物件、粒子與介面貼圖，應從網路尋找風格匹配、**開源／CC0／無版權爭議或授權自由商業與開發使用（Open-Source / Royalty-Free Assets）** 之高質量遊戲素材進行整合。
4. **禁止以簡陋基本幾何圖形直接手繪充數**
   - **不建議由 Agent 直接以單純的圓圈、圓點、直線等基本繪圖原語（basic drawing primitives）硬畫角色、武器、物件或複雜技能美術**，原因如下：
     - Agent 直接用基礎幾何度量繪製的細節貧乏；
     - 視覺層次與整體美術觀感往往不夠精緻；
     - 基於真實參考圖之圖片生成方案，或經過挑選的開源高品質素材，最終呈現效果必定明顯優於簡陋幾何手繪。

---

## 5. 遊戲音效設計規範 (Game Sound Effect Design Guidelines)

進行角色互動、武器戰鬥或動作設計時（本規範優先聚焦於**角色與戰鬥互動音效**，暫不涵蓋 GUI 或背景音樂），所有 Agent 必須嚴格遵守以下音效原則：

1. **角色互動必須具備清晰音效回饋**
   - 角色的核心戰鬥與互動動作（開槍、大刀／小刀／雙爪揮斬、盾牌推擊、命中打擊、切武、裝彈、拾取、腳步等）必須具備即時、聽感明確的聲音回饋，確保動作手感完整。
2. **禁止以簡陋程式合成或直接操縱位元生成正式音效**
   - **嚴禁由 Agent 以簡陋或土法煉鋼的方式自行生成正式音效**（例如直接操縱音頻 bit、手寫隨機雜訊陣列 `Math.random()` 或僅以基本 `OscillatorNode` 波形拼湊揮刀聲／打擊聲）。
   - `sfx.ts` 內的基礎波形合成僅可保留為遠端樣本載入失敗時的最低限度降級保底（Fallback），不可作為正式遊戲音效方案。
3. **正確音效取得與製作流程**
   - **具備專用音訊生成工具 (Audio Generation Tooling) 時**：可參考《光暈戰記》原作音效聽感生成樣本，經人工／試聽驗收無誤後再行導入。
   - **無專用生成工具時（標準做法）**：參考原版《光暈戰記》動作聽感，並優先從網路搜尋**無版權爭議、CC0 1.0 公眾領域或開源免費商用（Open-Source / Royalty-Free）**的高品質真實錄製音檔素材（例如 Freesound CC0、OpenGameArt CC0、Kenney.nl CC0）。
4. **音檔管理與授權登記規範**
   - 所有導入之 `.wav` / 音頻素材統一存放於 `public/assets/audio/`（需預先裁剪前導靜音、尾段淡出並一致化峰值音量，維持輕量載入）。
   - **每次新增或替換音檔時，必須同步更新 `public/assets/audio/credits.txt`**，完整註明原始檔名、原作者、來源網址、CC0／開源授權條款連結及遊戲內裁切處理說明。

---

## 6. 工程架構守則

1. **貫徹玩家與 AI 資料及邏輯對稱**：除非模式明確規範差異（如經典模式玩家備彈上限 vs AI 無限備彈），否則一律共用相同狀態結構（如 `EquippedWeapon`）、換彈／換手取消、物理高度檢查與技能數值，嚴禁另建平行狀態機或殘留專用欄位。
2. **維護模組邊界與清除 Dead Code**：通用引擎、2.5D 物理與三層地圖規則應與模式專屬邏輯（`siegeData.ts`、`siegeHelpers.ts`、`siegeMap.ts`、`siegeRenderer.ts`）清楚分層；規則重構後立即清理過時欄位與無用程式碼。
3. **不變量與邊界雙重檢查**：每次改動核心機制須確認邊界情況（限時 Buff 到期、友軍誤傷旗標、盾牌 0 傷害與耐久保留、換手立即取消換彈、多格物件等高與三方 BFS 連通）。

---

## 7. 驗證檢查清單（每次改動後必跑）

1. **`npm test -- --run`**：通過全部 Vitest 測試（`engine.test.ts`、`siege.test.ts`、`protocol.test.ts`）；新增或修改玩法時須同步補充對應測試。
2. **`npm run lint`**：前端與 Worker TypeScript 編譯零錯誤通過（退出碼 `0`）。
3. **`npm run build`**：Vite 正式環境建置成功。
4. **實機視覺／動畫驗收**：凡涉及畫布渲染、角色持武、動畫方向或 UI 排版調整，須啟動 Port `3000` 確認畫面無執行期錯誤，並優先以**真實遊戲畫面擷圖或實機錄影**向使用者展示驗收結果（禁止以脫離遊戲本體的模擬畫布代替）。
