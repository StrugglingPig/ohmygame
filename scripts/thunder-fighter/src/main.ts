import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";

type AssetKey = "player" | "enemy" | "boss";
type GameState = "ready" | "playing" | "paused" | "gameover" | "won";

interface AssetManifest {
  assets: Record<AssetKey, { glbPath: string }>;
}

interface HudState {
  score: number;
  wave: number;
  lives: number;
  weaponLevel: number;
  bossHp?: number;
  bossMaxHp?: number;
}

interface Ui {
  hud(state: HudState): void;
  message(text: string, duration?: number): void;
  gameOver(score: number): void;
  won(score: number): void;
  paused(paused: boolean): void;
}

interface Player {
  root: THREE.Group;
  x: number;
  y: number;
  cooldown: number;
  invulnerable: number;
}

interface Enemy {
  root: THREE.Group;
  x: number;
  y: number;
  hp: number;
  speed: number;
  phase: number;
  shootTimer: number;
}

interface Boss {
  root: THREE.Group;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  phase: number;
  shootTimer: number;
}

interface Bullet {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  speed: number;
  hostile: boolean;
}

interface Powerup {
  mesh: THREE.Mesh;
  x: number;
  y: number;
}

interface Particle {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

class SoundKit {
  private context?: AudioContext;
  private master?: GainNode;
  enabled = true;

  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.master) this.master.gain.value = this.enabled ? 0.14 : 0;
    return this.enabled;
  }

  private ensure(): AudioContext | undefined {
    if (!this.enabled) return undefined;
    if (!this.context) {
      const AudioContextClass =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextClass) return undefined;
      this.context = new AudioContextClass();
      this.master = this.context.createGain();
      this.master.gain.value = 0.14;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === "suspended") void this.context.resume();
    return this.context;
  }

  private tone(
    start: number,
    end: number,
    duration: number,
    type: OscillatorType,
    volume = 0.18,
  ): void {
    const context = this.ensure();
    if (!context || !this.master) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(start, now);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, end),
      now + duration,
    );
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  shoot(): void {
    this.tone(680, 240, 0.045, "square", 0.045);
  }
  hit(): void {
    this.tone(150, 60, 0.12, "sawtooth", 0.12);
  }
  explode(): void {
    this.tone(120, 35, 0.18, "triangle", 0.15);
  }
  pickup(): void {
    this.tone(520, 1040, 0.16, "sine", 0.11);
  }
  boss(): void {
    this.tone(85, 45, 0.6, "sawtooth", 0.14);
  }
}

class ThunderFighter {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(
    -16,
    16,
    10,
    -10,
    0.1,
    100,
  );
  private readonly renderer: THREE.WebGLRenderer;
  private readonly loader = new GLTFLoader();
  private readonly entityRoot = new THREE.Group();
  private readonly fxRoot = new THREE.Group();
  private readonly starRoot = new THREE.Group();
  private readonly sound = new SoundKit();
  private readonly keys = new Set<string>();
  private readonly prototypes = new Map<AssetKey, THREE.Group>();
  private readonly starSpeeds: number[] = [];
  private readonly bulletGeometry = new THREE.SphereGeometry(0.09, 8, 8);
  private readonly hostileBulletMaterial = new THREE.MeshBasicMaterial({
    color: 0xff674d,
  });
  private readonly friendlyBulletMaterial = new THREE.MeshBasicMaterial({
    color: 0x6ff2ff,
  });
  private readonly particleGeometry = new THREE.IcosahedronGeometry(0.08, 0);
  private readonly clock = new THREE.Clock();

  private state: GameState = "ready";
  private viewWidth = 32;
  private viewHeight = 20;
  private stars?: THREE.Points;
  private player?: Player;
  private boss?: Boss;
  private enemies: Enemy[] = [];
  private bullets: Bullet[] = [];
  private powerups: Powerup[] = [];
  private particles: Particle[] = [];
  private score = 0;
  private lives = 3;
  private weaponLevel = 1;
  private wave = 1;
  private waveKills = 0;
  private waveTarget = 10;
  private waveTransition = 0;
  private spawnTimer = 0.8;
  private totalKills = 0;
  private pointerActive = false;
  private pointerTarget?: { x: number; y: number };
  private readonly boundFrame = (time: number) => this.frame(time);
  private readonly boundResize = () => this.resize();
  private readonly boundVisibility = () => {
    if (document.hidden && this.state === "playing") this.togglePause();
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly ui: Ui,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.root.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x050b17);
    this.scene.fog = new THREE.Fog(0x050b17, 18, 38);
    this.scene.add(this.entityRoot, this.fxRoot, this.starRoot);
    this.addLights();
    this.createStars();
    this.bindInput();
    this.resize();
    this.renderer.setAnimationLoop(this.boundFrame);
  }

  async init(): Promise<void> {
    const manifest = await fetch("./game-assets.json", {
      cache: "no-store",
    }).then((response) => {
      if (!response.ok)
        throw new Error(`Asset manifest failed: ${response.status}`);
      return response.json() as Promise<AssetManifest>;
    });
    const entries = await Promise.all(
      (Object.keys(manifest.assets) as AssetKey[]).map(async (key) => {
        const gltf = await this.loader.loadAsync(
          `./${manifest.assets[key].glbPath}`,
        );
        return [key, this.preparePrototype(key, gltf)] as const;
      }),
    );
    for (const [key, prototype] of entries) this.prototypes.set(key, prototype);
    document.body.dataset.gameReady = "true";
    this.ui.message("SYSTEM READY");
  }

  start(): void {
    this.reset();
    this.state = "playing";
    this.ui.paused(false);
    this.ui.message("INTERCEPT");
    this.sound.pickup();
    this.emitHud();
  }

  togglePause(): void {
    if (this.state === "playing") {
      this.state = "paused";
      this.keys.clear();
      this.pointerActive = false;
      this.ui.paused(true);
    } else if (this.state === "paused") {
      this.state = "playing";
      this.ui.paused(false);
    }
  }

  toggleSound(): boolean {
    return this.sound.toggle();
  }

  snapshot(): Record<string, unknown> {
    return {
      state: this.state,
      ready: document.body.dataset.gameReady === "true",
      score: this.score,
      lives: this.lives,
      wave: this.wave,
      weaponLevel: this.weaponLevel,
      enemies: this.enemies.length,
      bullets: this.bullets.length,
      powerups: this.powerups.length,
      powerupPositions: this.powerups.map((powerup) => ({
        x: powerup.x,
        y: powerup.y,
      })),
      bossHp: this.boss?.hp,
      bossMaxHp: this.boss?.maxHp,
      player: this.player ? { x: this.player.x, y: this.player.y } : undefined,
      view: { width: this.viewWidth, height: this.viewHeight },
    };
  }

  forceBoss(): void {
    if (this.state !== "playing") return;
    for (const enemy of [...this.enemies]) this.removeEnemy(enemy);
    for (const bullet of [...this.bullets]) this.removeBullet(bullet);
    this.wave = 2;
    this.waveKills = this.waveTarget;
    this.waveTransition = 0.05;
  }

  defeatBoss(): void {
    if (!this.boss) return;
    this.boss.hp = 0;
    this.destroyBoss();
  }

  debugDropPowerup(): void {
    if (!this.player || this.state !== "playing") return;
    this.spawnPowerup(this.player.x, this.player.y - 0.35);
  }

  private addLights(): void {
    this.scene.add(new THREE.AmbientLight(0x7e9fc0, 1.25));
    const key = new THREE.DirectionalLight(0xb9f6ff, 2.8);
    key.position.set(-6, 18, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xff4d6d, 1.1);
    rim.position.set(8, 10, -8);
    this.scene.add(rim);
  }

  private createStars(): void {
    const positions: number[] = [];
    for (let index = 0; index < 260; index += 1) {
      positions.push(
        (Math.random() - 0.5) * 48,
        -1.1 - Math.random() * 2.2,
        (Math.random() - 0.5) * 34,
      );
      this.starSpeeds.push(0.5 + Math.random() * 2.4);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    const material = new THREE.PointsMaterial({
      color: 0x7adfff,
      size: 0.08,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this.stars = new THREE.Points(geometry, material);
    this.starRoot.add(this.stars);
  }

  private bindInput(): void {
    window.addEventListener("resize", this.boundResize);
    document.addEventListener("visibilitychange", this.boundVisibility);
    window.addEventListener("keydown", (event) => {
      if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(
          event.key,
        )
      )
        event.preventDefault();
      if (event.key === "p" || event.key === "P" || event.key === "Escape")
        this.togglePause();
      this.keys.add(event.key.toLowerCase());
    });
    window.addEventListener("keyup", (event) =>
      this.keys.delete(event.key.toLowerCase()),
    );
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.pointerActive = false;
    });

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (event) => {
      if (this.state !== "playing") return;
      this.pointerActive = true;
      canvas.setPointerCapture(event.pointerId);
      this.pointerTarget = this.pointerWorld(event);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!this.pointerActive || this.state !== "playing") return;
      this.pointerTarget = this.pointerWorld(event);
    });
    const release = () => {
      this.pointerActive = false;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
  }

  private pointerWorld(event: PointerEvent): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return {
      x: (ndcX * this.viewWidth) / 2,
      y: (-ndcY * this.viewHeight) / 2 + this.viewHeight / 2,
    };
  }

  private resize(): void {
    const width = Math.max(1, this.root.clientWidth);
    const height = Math.max(1, this.root.clientHeight);
    const aspect = width / height;
    this.viewWidth = Math.max(10, 12 * aspect);
    this.viewHeight = this.viewWidth / aspect;
    this.camera.left = -this.viewWidth / 2;
    this.camera.right = this.viewWidth / 2;
    this.camera.top = this.viewHeight / 2;
    this.camera.bottom = -this.viewHeight / 2;
    this.camera.position.set(0, 22, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if (this.player) this.clampPlayer();
  }

  private preparePrototype(key: AssetKey, gltf: GLTF): THREE.Group {
    const model = gltf.scene;
    const palette =
      key === "player"
        ? { body: 0x0d4d72, accent: 0x41e7ff, metalness: 0.7, roughness: 0.32 }
        : key === "enemy"
          ? {
              body: 0x5c151b,
              accent: 0xff573d,
              metalness: 0.55,
              roughness: 0.4,
            }
          : {
              body: 0x33164d,
              accent: 0xd35cff,
              metalness: 0.62,
              roughness: 0.38,
            };
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const name = object.name.toLowerCase();
      const accent = /accent|canopy|engine|eye|core|tip|turret/.test(name);
      const material = new THREE.MeshStandardMaterial({
        color: accent ? palette.accent : palette.body,
        emissive: accent ? palette.accent : palette.body,
        emissiveIntensity: accent ? 0.5 : 0.08,
        metalness: palette.metalness,
        roughness: palette.roughness,
        transparent: name.includes("canopy"),
        opacity: name.includes("canopy") ? 0.78 : 1,
        side: THREE.DoubleSide,
      });
      object.material = material;
      object.castShadow = false;
      object.receiveShadow = false;
    });
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const target = key === "player" ? 2.1 : key === "enemy" ? 1.8 : 6.0;
    const scale = target / Math.max(size.x, size.z, 0.001);
    model.scale.setScalar(scale);
    box.setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const wrapper = new THREE.Group();
    wrapper.add(model);
    if (key === "player") wrapper.rotation.y = Math.PI;
    return wrapper;
  }

  private clonePrototype(key: AssetKey): THREE.Group {
    const prototype = this.prototypes.get(key);
    if (!prototype) throw new Error(`Missing ${key} prototype`);
    const clone = prototype.clone(true);
    this.entityRoot.add(clone);
    return clone;
  }

  private reset(): void {
    this.clearBattlefield();
    this.score = 0;
    this.lives = 3;
    this.weaponLevel = 1;
    this.wave = 1;
    this.waveKills = 0;
    this.waveTarget = 10;
    this.waveTransition = 0;
    this.spawnTimer = 0.8;
    this.totalKills = 0;
    this.pointerTarget = undefined;
    this.player = {
      root: this.clonePrototype("player"),
      x: 0,
      y: this.viewHeight - 3.1,
      cooldown: 0,
      invulnerable: 1.2,
    };
    this.setPosition(this.player.root, this.player.x, this.player.y, 0.2);
    this.emitHud();
  }

  private clearBattlefield(): void {
    for (const enemy of this.enemies) this.entityRoot.remove(enemy.root);
    for (const bullet of this.bullets) this.entityRoot.remove(bullet.mesh);
    for (const powerup of this.powerups) this.entityRoot.remove(powerup.mesh);
    if (this.boss) this.entityRoot.remove(this.boss.root);
    if (this.player) this.entityRoot.remove(this.player.root);
    this.enemies = [];
    this.bullets = [];
    this.powerups = [];
    this.boss = undefined;
    this.player = undefined;
  }

  private frame(time: number): void {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.updateStars(dt);
    if (this.state === "playing") this.update(dt);
    this.renderer.render(this.scene, this.camera);
    if (time < 0) return;
  }

  private update(dt: number): void {
    if (!this.player) return;
    this.player.invulnerable = Math.max(0, this.player.invulnerable - dt);
    this.player.cooldown -= dt;
    this.updatePlayer(dt);
    this.updateSpawner(dt);
    this.updateBullets(dt);
    this.updateEnemies(dt);
    this.updateBoss(dt);
    this.updatePowerups(dt);
    this.updateParticles(dt);
    if (this.player.cooldown <= 0) this.firePlayerWeapon();
    this.emitHud();
  }

  private updatePlayer(dt: number): void {
    const player = this.player!;
    const speed = 10.5;
    let dx = 0;
    let dy = 0;
    if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
    if (this.keys.has("w") || this.keys.has("arrowup")) dy -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) dy += 1;
    if (dx || dy) {
      const length = Math.hypot(dx, dy) || 1;
      player.x += (dx / length) * speed * dt;
      player.y += (dy / length) * speed * dt;
    } else if (this.pointerTarget) {
      player.x = THREE.MathUtils.lerp(
        player.x,
        this.pointerTarget.x,
        Math.min(1, dt * 18),
      );
      player.y = THREE.MathUtils.lerp(
        player.y,
        this.pointerTarget.y - 0.6,
        Math.min(1, dt * 18),
      );
    }
    this.clampPlayer();
    this.setPosition(player.root, player.x, player.y, 0.2);
    player.root.visible =
      player.invulnerable <= 0 ||
      Math.floor(player.invulnerable * 14) % 2 === 0;
  }

  private clampPlayer(): void {
    if (!this.player) return;
    this.player.x = THREE.MathUtils.clamp(
      this.player.x,
      -this.viewWidth / 2 + 1,
      this.viewWidth / 2 - 1,
    );
    this.player.y = THREE.MathUtils.clamp(
      this.player.y,
      2.5,
      this.viewHeight - 1.8,
    );
  }

  private updateSpawner(dt: number): void {
    if (this.boss) return;
    if (this.waveTransition > 0) {
      this.waveTransition -= dt;
      if (this.waveTransition <= 0) {
        if (this.wave === 1) {
          this.wave = 2;
          this.waveKills = 0;
          this.waveTarget = 14;
          this.spawnTimer = 0.6;
          this.ui.message("WAVE 2");
          this.emitHud();
        } else {
          this.spawnBoss();
        }
      }
      return;
    }
    if (this.waveKills >= this.waveTarget) {
      this.waveTransition = 1.4;
      this.ui.message(this.wave === 1 ? "WAVE CLEAR" : "WARNING · BOSS", 1.3);
      return;
    }
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnEnemy();
      this.spawnTimer = this.wave === 1 ? 0.86 : 0.68;
    }
  }

  private spawnEnemy(): void {
    const root = this.clonePrototype("enemy");
    const x = THREE.MathUtils.randFloat(
      -this.viewWidth / 2 + 1.2,
      this.viewWidth / 2 - 1.2,
    );
    const enemy: Enemy = {
      root,
      x,
      y: -1,
      hp: this.wave === 1 ? 1 : 2,
      speed: this.wave === 1 ? 2.6 : 3.25,
      phase: Math.random() * Math.PI * 2,
      shootTimer: 1.5 + Math.random() * 1.5,
    };
    this.enemies.push(enemy);
    this.setPosition(root, enemy.x, enemy.y, 0.1);
  }

  private updateEnemies(dt: number): void {
    if (!this.player) return;
    for (const enemy of [...this.enemies]) {
      enemy.y += enemy.speed * dt;
      enemy.phase += dt * 2.3;
      enemy.x += Math.sin(enemy.phase) * 0.28 * dt;
      this.setPosition(enemy.root, enemy.x, enemy.y, 0.1);
      if (this.wave >= 2 && this.boss === undefined) {
        enemy.shootTimer -= dt;
        if (enemy.shootTimer <= 0 && enemy.y < this.viewHeight - 4) {
          this.fireEnemyBullet(enemy.x, enemy.y + 0.4);
          enemy.shootTimer = 1.8 + Math.random() * 1.8;
        }
      }
      if (enemy.y > this.viewHeight + 2) {
        this.removeEnemy(enemy);
        continue;
      }
      if (
        this.distance(enemy.x, enemy.y, this.player.x, this.player.y) < 1.15
      ) {
        this.removeEnemy(enemy);
        this.damagePlayer();
      }
    }
  }

  private updateBoss(dt: number): void {
    const boss = this.boss;
    if (!boss || !this.player) return;
    boss.phase += dt * 0.8;
    boss.x = Math.sin(boss.phase) * Math.max(2.4, this.viewWidth * 0.18);
    boss.y = 3.4 + Math.sin(boss.phase * 1.3) * 0.45;
    boss.shootTimer -= dt;
    if (boss.shootTimer <= 0) {
      const spread = this.weaponLevel >= 3 ? 7 : 5;
      for (let index = 0; index < spread; index += 1) {
        const angle = Math.PI / 2 + (index - (spread - 1) / 2) * 0.17;
        this.fireHostileBullet(
          boss.x,
          boss.y + 1,
          Math.cos(angle) * 6.5,
          Math.sin(angle) * 6.5,
        );
      }
      boss.shootTimer = 1.1;
    }
    this.setPosition(boss.root, boss.x, boss.y, 0.3);
    if (this.distance(boss.x, boss.y, this.player.x, this.player.y) < 2.6)
      this.damagePlayer();
  }

  private spawnBoss(): void {
    const root = this.clonePrototype("boss");
    const maxHp = 48;
    this.wave = 3;
    this.boss = {
      root,
      x: 0,
      y: 3.2,
      hp: maxHp,
      maxHp,
      phase: 0,
      shootTimer: 1.6,
    };
    this.setPosition(root, 0, this.boss.y, 0.3);
    this.ui.message("DREADNOUGHT", 1.5);
    this.sound.boss();
    this.emitHud();
  }

  private firePlayerWeapon(): void {
    if (!this.player) return;
    const level = this.weaponLevel;
    const offsets =
      level === 1 ? [0] : level === 2 ? [-0.24, 0.24] : [-0.34, 0, 0.34];
    for (const offset of offsets)
      this.fireFriendlyBullet(this.player.x + offset, this.player.y - 0.8);
    this.player.cooldown = level === 3 ? 0.105 : 0.135;
    this.sound.shoot();
  }

  private fireFriendlyBullet(x: number, y: number): void {
    const mesh = new THREE.Mesh(
      this.bulletGeometry,
      this.friendlyBulletMaterial,
    );
    this.entityRoot.add(mesh);
    this.bullets.push({ mesh, x, y, speed: -22, hostile: false });
  }

  private fireEnemyBullet(x: number, y: number): void {
    this.fireHostileBullet(x, y, 0, 8.5);
  }

  private fireHostileBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
  ): void {
    const mesh = new THREE.Mesh(
      this.bulletGeometry,
      this.hostileBulletMaterial,
    );
    this.entityRoot.add(mesh);
    const bullet = { mesh, x, y, speed: vy, hostile: true };
    this.bullets.push(bullet);
    if (vx !== 0) {
      (bullet as Bullet & { vx?: number }).vx = vx;
      const angle = Math.atan2(vy, vx) - Math.PI / 2;
      mesh.rotation.z = angle;
    }
  }

  private updateBullets(dt: number): void {
    if (!this.player) return;
    for (const bullet of [...this.bullets]) {
      const extra = (bullet as Bullet & { vx?: number }).vx ?? 0;
      bullet.x += extra * dt;
      bullet.y += bullet.speed * dt;
      this.setPosition(bullet.mesh, bullet.x, bullet.y, 0.35);
      if (
        bullet.y < -2 ||
        bullet.y > this.viewHeight + 2 ||
        Math.abs(bullet.x) > this.viewWidth / 2 + 3
      ) {
        this.removeBullet(bullet);
        continue;
      }
      if (bullet.hostile) {
        if (
          this.distance(bullet.x, bullet.y, this.player.x, this.player.y) < 0.7
        ) {
          this.removeBullet(bullet);
          this.damagePlayer();
        }
        continue;
      }
      let hit = false;
      for (const enemy of [...this.enemies]) {
        if (this.distance(bullet.x, bullet.y, enemy.x, enemy.y) >= 0.78)
          continue;
        enemy.hp -= 1;
        this.removeBullet(bullet);
        hit = true;
        if (enemy.hp <= 0) this.destroyEnemy(enemy);
        break;
      }
      if (hit) continue;
      if (
        this.boss &&
        this.distance(bullet.x, bullet.y, this.boss.x, this.boss.y) < 2.5
      ) {
        this.removeBullet(bullet);
        this.boss.hp -= 1;
        if (this.boss.hp <= 0) this.destroyBoss();
      }
    }
  }

  private destroyEnemy(enemy: Enemy): void {
    this.explode(enemy.x, enemy.y, 0xff654d, 10);
    this.removeEnemy(enemy);
    this.score += 100 + this.wave * 25;
    this.totalKills += 1;
    this.waveKills += 1;
    this.sound.explode();
    if (this.totalKills % 7 === 0) this.spawnPowerup(enemy.x, enemy.y);
    this.emitHud();
  }

  private removeEnemy(enemy: Enemy): void {
    this.entityRoot.remove(enemy.root);
    this.enemies = this.enemies.filter((candidate) => candidate !== enemy);
  }

  private removeBullet(bullet: Bullet): void {
    this.entityRoot.remove(bullet.mesh);
    this.bullets = this.bullets.filter((candidate) => candidate !== bullet);
  }

  private spawnPowerup(x: number, y: number): void {
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({
        color: 0x71ffb3,
        emissive: 0x24c878,
        emissiveIntensity: 1.2,
        metalness: 0.25,
        roughness: 0.25,
      }),
    );
    this.entityRoot.add(mesh);
    this.powerups.push({ mesh, x, y });
    this.setPosition(mesh, x, y, 0.5);
  }

  private updatePowerups(dt: number): void {
    if (!this.player) return;
    for (const powerup of [...this.powerups]) {
      powerup.y += 3.5 * dt;
      powerup.mesh.rotation.y += dt * 2.8;
      powerup.mesh.rotation.x += dt * 1.4;
      this.setPosition(
        powerup.mesh,
        powerup.x,
        powerup.y,
        0.5 + Math.sin(powerup.y * 2) * 0.1,
      );
      if (
        this.distance(powerup.x, powerup.y, this.player.x, this.player.y) < 0.9
      ) {
        this.collectPowerup(powerup);
        continue;
      }
      if (powerup.y > this.viewHeight + 2) {
        this.entityRoot.remove(powerup.mesh);
        this.powerups = this.powerups.filter(
          (candidate) => candidate !== powerup,
        );
      }
    }
  }

  private collectPowerup(powerup: Powerup): void {
    this.entityRoot.remove(powerup.mesh);
    this.powerups = this.powerups.filter((candidate) => candidate !== powerup);
    if (this.weaponLevel < 3) {
      this.weaponLevel += 1;
      this.ui.message(`FIREPOWER LV.${this.weaponLevel}`);
    } else if (this.lives < 3) {
      this.lives = Math.min(3, this.lives + 1);
      this.score += 350;
      this.ui.message("HULL REPAIR");
    } else {
      this.score += 350;
      this.ui.message("BONUS +350");
    }
    this.sound.pickup();
    this.emitHud();
  }

  private destroyBoss(): void {
    if (!this.boss) return;
    const boss = this.boss;
    this.explode(boss.x, boss.y, 0xff573d, 30);
    this.entityRoot.remove(boss.root);
    this.boss = undefined;
    this.score += 5000;
    this.sound.explode();
    this.state = "won";
    this.ui.won(this.score);
    this.emitHud();
  }

  private damagePlayer(): void {
    if (!this.player || this.player.invulnerable > 0) return;
    this.lives -= 1;
    this.player.invulnerable = 1.6;
    this.explode(this.player.x, this.player.y, 0x41e7ff, 14);
    this.sound.hit();
    document.body.dataset.hit = "true";
    window.setTimeout(() => {
      delete document.body.dataset.hit;
    }, 180);
    if (this.lives <= 0) {
      this.state = "gameover";
      this.ui.gameOver(this.score);
    }
    this.emitHud();
  }

  private explode(x: number, y: number, color: number, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(this.particleGeometry, material);
      this.fxRoot.add(mesh);
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 5.5;
      this.particles.push({
        mesh,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.35 + Math.random() * 0.45,
        maxLife: 0.8,
      });
      this.setPosition(mesh, x, y, 0.4);
    }
  }

  private updateParticles(dt: number): void {
    for (const particle of [...this.particles]) {
      particle.life -= dt;
      particle.mesh.position.x += particle.vx * dt;
      particle.mesh.position.z += particle.vy * dt;
      particle.mesh.position.y += 0.8 * dt;
      particle.mesh.scale.setScalar(
        Math.max(0.15, particle.life / particle.maxLife),
      );
      const material = particle.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = Math.max(0, particle.life / particle.maxLife);
      if (particle.life <= 0) {
        this.fxRoot.remove(particle.mesh);
        material.dispose();
        this.particles = this.particles.filter(
          (candidate) => candidate !== particle,
        );
      }
    }
  }

  private updateStars(dt: number): void {
    if (!this.stars) return;
    const attribute = this.stars.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    for (let index = 0; index < attribute.count; index += 1) {
      const z =
        attribute.getZ(index) +
        (this.state === "playing"
          ? this.starSpeeds[index] * dt * 3.2
          : this.starSpeeds[index] * dt * 0.7);
      attribute.setZ(
        index,
        z > this.viewHeight / 2 + 4 ? -this.viewHeight / 2 - 4 : z,
      );
    }
    attribute.needsUpdate = true;
  }

  private setPosition(
    root: THREE.Object3D,
    x: number,
    y: number,
    height: number,
  ): void {
    root.position.set(x, height, y - this.viewHeight / 2);
  }

  private distance(ax: number, ay: number, bx: number, by: number): number {
    return Math.hypot(ax - bx, ay - by);
  }

  private emitHud(): void {
    this.ui.hud({
      score: this.score,
      wave: this.wave,
      lives: this.lives,
      weaponLevel: this.weaponLevel,
      ...(this.boss
        ? { bossHp: this.boss.hp, bossMaxHp: this.boss.maxHp }
        : {}),
    });
  }
}

const scoreElement = document.getElementById("score")!;
const waveElement = document.getElementById("wave-label")!;
const objectiveElement = document.getElementById("objective")!;
const livesElement = document.getElementById("lives")!;
const weaponElement = document.getElementById("weapon")!;
const bossHud = document.getElementById("boss-hud") as HTMLElement;
const bossFill = document.getElementById("boss-fill") as HTMLElement;
const messageElement = document.getElementById("message")!;
const startScreen = document.getElementById("start-screen") as HTMLElement;
const pauseScreen = document.getElementById("pause-screen") as HTMLElement;
const endScreen = document.getElementById("end-screen") as HTMLElement;
const endEyebrow = document.getElementById("end-eyebrow")!;
const endTitle = document.getElementById("end-title")!;
const endSummary = document.getElementById("end-summary")!;
const highScoreElement = document.getElementById("high-score")!;
const startButton = document.getElementById(
  "start-button",
) as HTMLButtonElement;
const resumeButton = document.getElementById(
  "resume-button",
) as HTMLButtonElement;
const restartButton = document.getElementById(
  "restart-button",
) as HTMLButtonElement;
const soundButton = document.getElementById(
  "sound-toggle",
) as HTMLButtonElement;
const loadStatus = document.getElementById("load-status")!;
const highScoreKey = "thunder-fighter-high-score";
let messageHideTimer: number | undefined;
highScoreElement.textContent = String(
  Number(localStorage.getItem(highScoreKey) ?? "0"),
).padStart(6, "0");

const ui: Ui = {
  hud(state) {
    scoreElement.textContent = String(state.score).padStart(6, "0");
    waveElement.textContent = state.wave === 3 ? "BOSS" : `WAVE ${state.wave}`;
    objectiveElement.textContent =
      state.wave === 3
        ? "击毁 Dreadnought"
        : state.wave === 1
          ? "清除敌机中队"
          : "突破第二封锁";
    livesElement.textContent = Array.from(
      { length: Math.max(0, state.lives) },
      () => "◆",
    ).join(" ");
    weaponElement.textContent = `火力 LV.${state.weaponLevel}`;
    if (state.bossHp !== undefined && state.bossMaxHp) {
      bossHud.hidden = false;
      bossFill.style.transform = `scaleX(${Math.max(0, state.bossHp / state.bossMaxHp)})`;
    } else {
      bossHud.hidden = true;
    }
  },
  message(text, duration = 1.6) {
    if (messageHideTimer !== undefined) window.clearTimeout(messageHideTimer);
    messageElement.textContent = text;
    messageElement.classList.toggle("visible", Boolean(text));
    if (text) {
      messageHideTimer = window.setTimeout(() => {
        messageElement.classList.remove("visible");
        messageElement.textContent = "";
        messageHideTimer = undefined;
      }, duration * 1000);
    }
  },
  gameOver(score) {
    showEnd("MISSION FAILED", "任务失败", score);
  },
  won(score) {
    showEnd("MISSION COMPLETE", "航道夺回", score);
  },
  paused(paused) {
    pauseScreen.hidden = !paused;
  },
};

const game = new ThunderFighter(document.getElementById("render-root")!, ui);

function showEnd(eyebrow: string, title: string, score: number): void {
  endEyebrow.textContent = eyebrow;
  endTitle.textContent = title;
  endSummary.textContent = `本次得分 ${String(score).padStart(6, "0")}`;
  const previous = Number(localStorage.getItem(highScoreKey) ?? "0");
  const best = Math.max(previous, score);
  localStorage.setItem(highScoreKey, String(best));
  highScoreElement.textContent = String(best).padStart(6, "0");
  endScreen.hidden = false;
}

function begin(): void {
  endScreen.hidden = true;
  pauseScreen.hidden = true;
  startScreen.hidden = true;
  game.start();
}

startButton.addEventListener("click", begin);
restartButton.addEventListener("click", begin);
resumeButton.addEventListener("click", () => game.togglePause());
soundButton.addEventListener("click", () => {
  const on = game.toggleSound();
  soundButton.textContent = on ? "SOUND ON" : "SOUND OFF";
});

declare global {
  interface Window {
    __THUNDER_DEBUG__?: {
      snapshot(): Record<string, unknown>;
      start(): void;
      forceBoss(): void;
      defeatBoss(): void;
      dropPowerup(): void;
    };
  }
}

window.__THUNDER_DEBUG__ = {
  snapshot: () => game.snapshot(),
  start: begin,
  forceBoss: () => game.forceBoss(),
  defeatBoss: () => game.defeatBoss(),
  dropPowerup: () => game.debugDropPowerup(),
};

game
  .init()
  .then(() => {
    startButton.disabled = false;
    startButton.textContent = "开始任务";
    loadStatus.textContent = "三架 GameFactory 机体已装入 Asset Library";
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    document.body.dataset.gameError = message;
    startButton.textContent = "资产加载失败";
    loadStatus.textContent = message;
    ui.message("ASSET LOAD FAILED");
  });
