// The aircraft: a light single, flown arcade.
//
// It is a high-wing four-seater, not a fast jet and not a quadcopter, and both
// of those are deliberate. A jet over a real city reads as a strike package; a
// camera drone over a real city reads as surveillance. A Cessna over a real
// city reads as a nice afternoon, which is what this is.
//
// Arcade, not a simulator. There is no stall, no spin, no engine to manage and
// no way to break it, because the point is sightseeing. What it does NOT do is
// fake the air: wind, turbulence and density altitude come from the
// observation, so a gusty day genuinely shoves it around and a hot high
// afternoon genuinely climbs worse.
//
// The distinction that matters is between AIRSPEED and GROUNDSPEED. The model
// flies through a moving block of air: the throttle and the turn act on
// airspeed, but the aircraft's position advances by airspeed PLUS the wind
// vector. That one piece of honesty gives you drift, crab angle, and a
// downwind leg that eats the ground while the airspeed indicator never moves,
// all for free, and none of it is possible if you just add wind to the
// velocity you display.
//
// What it takes from the drone model it replaced -- and the reason it feels
// nothing like the fixed-wing model BEFORE that -- is the assistance:
//
//   ALTITUDE HOLD. With no vertical input it holds its height. A pitch axis
//     that self-centres to zero cannot hold a climb, and one that does not
//     self-centre needs trimming; a vertical-speed command needs neither.
//   ACTIVE BRAKING. The throttle commands a SPEED, and closing it actively
//     slows the aircraft instead of waiting for drag.
//   RATE-LIMITED, NOT FILTERED, controls. An exponential filter never reaches
//     the value you asked for, which reads as lag at any time constant.
//
// and the turn rate is deliberately about 2.5x what the real relation gives at
// these speeds. A truthful 60-degree bank at 90 kt is a 33-second circle, and
// a 33-second circle over Manhattan is not flying, it is waiting.

import * as THREE from "three";
import type { Weather } from "../data/weather";

const DEG = Math.PI / 180;
const G = 9.81;

export interface AircraftInput {
  /** -1..1 throttle change: positive accelerates, negative slows. */
  throttle: number;
  /** -1..1, roll left .. roll right. */
  roll: number;
  /** -1..1 rudder, positive yaws right. */
  yaw: number;
  /** -1..1 vertical speed command, positive climbs. */
  lift: number;
  /** 0..1. Full power and a higher bank limit; the sprint button. */
  boost: number;
}

export interface AircraftConfig {
  /** Metres per second at closed throttle and at open throttle. */
  minSpeed: number;
  cruiseSpeed: number;
  /** With boost held. */
  boostSpeed: number;
  /** Degrees per second of roll at full stick. */
  rollRate: number;
  /** Degrees of bank at full stick, and with boost held. */
  maxBank: number;
  boostBank: number;
  /** Degrees per second of yaw at full rudder. */
  rudderRate: number;
  /**
   * Metres per second of commanded climb at full stick.
   *
   * Deliberately far above a real light single's 5 m/s. A truthful climb over
   * a city is a minute of watching the same rooftops get slightly smaller, and
   * the vertical is half of what makes a valley or a canyon worth flying: you
   * want to be able to haul up over a rim and drop back into it.
   */
  climbRate: number;
  /**
   * How much faster than the real g*tan(bank)/V relation the aircraft turns.
   *
   * 1.0 is truthful and unflyable over a city; the honest part is kept -- the
   * turn still tightens as it slows and slackens as it speeds up, because the
   * relation is scaled rather than replaced by a constant rate.
   */
  turnGain: number;
  /** Airspeed the turn relation is evaluated at, at most. */
  turnRefSpeed: number;
  /** Seconds for the speed to close most of the way onto its command. */
  speedTau: number;
}

export const DEFAULT_CONFIG: AircraftConfig = {
  minSpeed: 22,
  cruiseSpeed: 62,
  boostSpeed: 88,
  rollRate: 130,
  maxBank: 55,
  boostBank: 70,
  rudderRate: 26,
  climbRate: 45,
  turnGain: 2.4,
  turnRefSpeed: 62,
  speedTau: 1.4,
};

/** Gentler everything, for `?easy`. Same shape, smaller numbers. */
export const EASY_CONFIG: AircraftConfig = {
  ...DEFAULT_CONFIG,
  cruiseSpeed: 46,
  boostSpeed: 60,
  rollRate: 85,
  maxBank: 38,
  boostBank: 48,
  climbRate: 22,
  turnGain: 2.0,
};

export class Aircraft {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly config: AircraftConfig;

  /** Velocity over the GROUND, m/s. Airspeed plus wind. What the map sees. */
  readonly velocity = new THREE.Vector3();

  /** Speed through the AIR along the nose, m/s. What the physics see. */
  airspeed: number;
  /** 0..1 throttle lever, which commands a speed rather than a power. */
  throttle = 0.72;

  private bank = 0;
  private pitchAngle = 0;
  private heading = 0;
  /** Rate of climb through the air, m/s. Commanded, then damped. */
  private climb = 0;

  /** Body rates, deg/s, measured from the attitude that actually resulted. */
  private pRate = 0;
  private qRate = 0;
  private rRate = 0;

  /** Set from the weather each frame. */
  private wind = new THREE.Vector3();
  private gustiness = 0;
  private densityRatio = 1;
  private turbPhase = Math.random() * 1000;

  /** Load factor in the aircraft's own vertical, in g. */
  loadFactor = 1;

  constructor(config: AircraftConfig = DEFAULT_CONFIG) {
    this.config = { ...config };
    this.airspeed = config.cruiseSpeed * 0.8;
  }

  /**
   * Push the observation into the model.
   *
   * Density altitude is the quietly important one: air density falls with
   * temperature and with pressure, and thrust and lift fall with it. A 35 C
   * afternoon in Dubai really does leave an aircraft mushy compared with a 5 C
   * morning in Reykjavik, and that is a difference a pilot feels immediately.
   */
  setWeather(wx: Weather, altitudeM: number): void {
    // Meteorological direction is where the wind comes FROM.
    const to = (wx.windDir + 180) * DEG;
    // Wind aloft is stronger than the 10 m reading and backs with height; a
    // rough power law is plenty for the feel of it.
    const shear = Math.pow(Math.max(altitudeM, 10) / 10, 0.16);
    const speed = wx.windSpeed * shear;
    this.wind.set(Math.sin(to) * speed, 0, -Math.cos(to) * speed);

    this.gustiness = Math.max(0, wx.gust - wx.windSpeed);

    // Density ratio from the ideal gas law against ISA sea level, with a rough
    // pressure lapse for altitude.
    const tempK = wx.tempC + 273.15 - 0.0065 * altitudeM;
    const pressure =
      wx.pressureHpa * Math.pow(1 - (0.0065 * altitudeM) / (wx.tempC + 273.15), 5.256);
    this.densityRatio = Math.max(0.35, (pressure / 1013.25) * (288.15 / Math.max(tempK, 200)));
  }

  /** Place the aircraft at a point, flying a compass heading, straight and level. */
  reset(x: number, y: number, z: number, headingDeg: number): void {
    this.position.set(x, y, z);
    // `heading` is the Euler rotation about +y, which runs COUNTER-clockwise,
    // while a compass runs clockwise. The two differ by a sign, and storing the
    // compass value directly here made the aircraft take off on the reciprocal
    // of the heading it was given: 300 was flown as 060.
    this.heading = -headingDeg * DEG;
    this.bank = 0;
    this.pitchAngle = 0;
    this.climb = 0;
    this.airspeed = this.config.cruiseSpeed * 0.85;
    this.velocity.set(0, 0, 0);
    this.syncQuaternion();
  }

  /**
   * Heading about +y, then pitch, then bank, in that order so bank is about the
   * aircraft's own longitudinal axis rather than the world's.
   *
   * Turbulence enters here as an offset on the commanded attitude rather than
   * being written into it, so the stored attitude stays exactly what the pilot
   * asked for and the chop cannot integrate.
   */
  private syncQuaternion(turbBank = 0, turbPitch = 0): void {
    // The roll term is NEGATED. The aircraft's forward axis is -z, and a
    // positive rotation about +z carries +x (the right wing) toward +y, i.e.
    // upward. So a positive `bank`, which the turn model treats as a RIGHT
    // bank, was drawn as a left one: the aircraft rolled away from the
    // direction it was turning, and the camera rolled with it.
    const e = new THREE.Euler(
      this.pitchAngle + turbPitch,
      this.heading,
      -(this.bank + turbBank),
      "YXZ",
    );
    this.quaternion.setFromEuler(e);
  }

  get headingDeg(): number {
    return (((-this.heading / DEG) % 360) + 360) % 360;
  }

  /** Nose-up positive, to match every attitude indicator ever built. */
  get pitchDeg(): number {
    return this.pitchAngle / DEG;
  }

  get rollDeg(): number {
    return this.bank / DEG;
  }

  /** Magnitude of the bank, which is what sets the turn rate. */
  get bankDeg(): number {
    return Math.abs(this.bank) / DEG;
  }

  get groundSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get verticalSpeed(): number {
    return this.velocity.y;
  }

  get rollRateDps(): number {
    return this.pRate;
  }
  get pitchRateDps(): number {
    return this.qRate;
  }
  get yawRateDps(): number {
    return this.rRate;
  }

  /** The wind the model is currently flying in, for the instruments. */
  get windVector(): THREE.Vector3 {
    return this.wind;
  }

  update(input: AircraftInput, dt: number, groundY: number): void {
    const c = this.config;
    const boost = THREE.MathUtils.clamp(input.boost, 0, 1);

    // --- Throttle ---------------------------------------------------------
    // The lever commands a SPEED, and it moves at a finite rate so that a tap
    // is a nudge. Closing it slows the aircraft actively rather than leaving it
    // to drag, which is the difference between a control and a suggestion.
    this.throttle = THREE.MathUtils.clamp(
      this.throttle + THREE.MathUtils.clamp(input.throttle, -1, 1) * dt * 0.85,
      0,
      1,
    );
    const top = THREE.MathUtils.lerp(c.cruiseSpeed, c.boostSpeed, boost);
    const wantSpeed = THREE.MathUtils.lerp(c.minSpeed, top, this.throttle) * this.densityRatio;

    // --- Attitude ---------------------------------------------------------
    const bankLimit = THREE.MathUtils.lerp(c.maxBank, c.boostBank, boost) * DEG;
    const prevBank = this.bank;
    this.bank += THREE.MathUtils.clamp(input.roll, -1, 1) * c.rollRate * DEG * dt;
    // Self-levelling: with the stick centred the aircraft rolls wings level.
    // Slower than it used to be, so a bank can be HELD through a lap of a
    // landmark rather than having to be flown continuously.
    if (Math.abs(input.roll) < 0.02) this.bank *= Math.pow(0.30, dt);
    this.bank = THREE.MathUtils.clamp(this.bank, -bankLimit, bankLimit);

    // --- Turn -------------------------------------------------------------
    // rate = g * tan(bank) / V, scaled. The reference speed caps how lazy a
    // fast pass is allowed to be while leaving the slow end truthful: a slow
    // aircraft still comes round noticeably tighter.
    const vRef = Math.min(Math.max(this.airspeed, 18), c.turnRefSpeed);
    const turnRate = (G * Math.tan(this.bank) * c.turnGain) / vRef;
    const prevHeading = this.heading;
    this.heading -= turnRate * dt;
    // Rudder is a small direct yaw, mostly for lining up on a landmark.
    this.heading -= THREE.MathUtils.clamp(input.yaw, -1, 1) * c.rudderRate * DEG * dt;

    // --- Climb ------------------------------------------------------------
    // A vertical-speed command, damped, so releasing the stick levels off
    // rather than freezing the nose wherever it was left. Climb performance
    // falls with density and with speed: a slow aeroplane on a hot day is a
    // mushy one, and that is a real and legible effect.
    const climbAuthority = this.densityRatio * THREE.MathUtils.clamp(this.airspeed / c.cruiseSpeed, 0.35, 1.2);
    const wantClimb = THREE.MathUtils.clamp(input.lift, -1, 1) * c.climbRate * climbAuthority;
    this.climb += (wantClimb - this.climb) * (1 - Math.pow(0.02, dt));

    // The nose follows the flight path, plus a little extra so a climb LOOKS
    // like a climb. Attitude here is cosmetic and the climb rate is the truth;
    // the reverse (deriving climb from attitude) is what made the old model
    // impossible to hold at a height.
    const prevPitch = this.pitchAngle;
    // The climb angle is allowed to go nearly VERTICAL. It used to be clamped
    // at 0.6 (34 degrees) with the nose capped at 38, which meant the sky was
    // something you could point at but never actually fly into: the aeroplane
    // stood on its tail at 38 degrees and stayed there however hard you pulled.
    // The energy term below is what keeps this honest rather than silly -- a
    // vertical climb costs airspeed fast, and the climb authority falls with
    // the airspeed, so it mushes out on its own instead of hanging there.
    const fpa = Math.asin(THREE.MathUtils.clamp(this.climb / Math.max(this.airspeed, 12), -0.985, 0.985));
    const wantPitch = THREE.MathUtils.clamp(fpa * 1.1, -82 * DEG, 82 * DEG);
    this.pitchAngle += (wantPitch - this.pitchAngle) * (1 - Math.pow(0.02, dt));

    // --- Speed ------------------------------------------------------------
    // Energy, roughly: climbing costs speed and descending gains it, on top of
    // whatever the throttle asked for.
    const gravityTerm = (-this.climb / Math.max(this.airspeed, 12)) * G * 1.15;
    this.airspeed += ((wantSpeed - this.airspeed) / c.speedTau + gravityTerm) * dt;
    this.airspeed = THREE.MathUtils.clamp(this.airspeed, c.minSpeed * 0.6, c.boostSpeed * 1.2);

    // --- Turbulence -------------------------------------------------------
    // Gusts are the difference between the reported wind and the reported gust.
    // A calm day is glassy; a 25 kt gust spread makes the aircraft work.
    //
    // Turbulence is a BOUNDED OFFSET on the attitude, not a rate added to it.
    // Integrating it was a real bug: a roll RATE of 0.33*g rad/s is ~40 degrees
    // per second cycling every few seconds, and the aircraft rocked
    // continuously and fought its own wings-level damping. That is a
    // resonance, not weather. An offset cannot accumulate.
    this.turbPhase += dt;
    let bumpY = 0;
    let turbBank = 0;
    let turbPitch = 0;
    if (this.gustiness > 0.3) {
      const g = this.gustiness;
      const p = this.turbPhase;
      turbBank = Math.sin(p * 1.7 + 0.7) * Math.sin(p * 0.41 + 1.9) * g * 0.0105;
      turbPitch = Math.sin(p * 2.1) * Math.sin(p * 0.33 + 0.4) * g * 0.0050;
      bumpY = Math.sin(p * 2.7) * Math.sin(p * 0.9 + 1.3) * g * 0.25;
    }

    this.syncQuaternion(turbBank, turbPitch);

    // Measured rates, from the attitude that actually resulted. Reporting the
    // COMMAND here would make the instruments agree with the controller rather
    // than with the aeroplane, which is exactly the reading that hides a bug.
    if (dt > 0) {
      this.pRate = (this.bank - prevBank) / DEG / dt;
      this.qRate = (this.pitchAngle - prevPitch) / DEG / dt;
      this.rRate = -(this.heading - prevHeading) / DEG / dt;
    }
    this.loadFactor = 1 / Math.max(0.2, Math.cos(this.bank));

    // --- Integrate --------------------------------------------------------
    // Airspeed along the nose, in the horizontal plane, plus the climb rate.
    // The horizontal component is scaled by cos(fpa) so a steep climb does not
    // secretly cover more ground than a level cruise at the same airspeed.
    const cosFpa = Math.cos(fpa);
    const air = new THREE.Vector3(
      Math.sin(this.heading) * -this.airspeed * cosFpa,
      this.climb + bumpY,
      Math.cos(this.heading) * -this.airspeed * cosFpa,
    );

    // Ground velocity is airspeed PLUS wind. This is what makes drift real.
    this.velocity.copy(air).add(this.wind);
    this.velocity.y = air.y;
    this.position.addScaledVector(this.velocity, dt);

    // --- Ground -----------------------------------------------------------
    // A hard floor rather than a crash: this is a sightseeing app, and ending
    // the flight because someone flew into a hill is a bad trade.
    const floor = groundY + 25;
    if (this.position.y < floor) {
      this.position.y = floor;
      if (this.climb < 0) this.climb *= 0.3;
    }
    if (this.position.y > 12000) {
      this.position.y = 12000;
      if (this.climb > 0) this.climb = 0;
    }
  }
}

/**
 * Pick a starting altitude that is not inside a cloud.
 *
 * The city's `startAlt` is chosen for how the place looks, with no knowledge of
 * the weather -- so on a day with a low deck the aircraft spawned inside it and
 * the first thing you saw was a featureless grey white-out. Istanbul with a 425
 * m base and the stock 600 m start did exactly that.
 *
 * Preference order: under the deck if there is usable room beneath it, else
 * above its top, else the city default.
 */
export function chooseStartAltitude(
  preferredAgl: number,
  groundY: number,
  deck: { cover: number; base: number; top: number },
): number {
  const wanted = groundY + preferredAgl;
  // A thin or broken deck is scenery to fly among, not an obstacle.
  if (deck.cover < 0.4) return wanted;

  const inDeck = wanted > deck.base - 120 && wanted < deck.top + 120;
  if (!inDeck) return wanted;

  // Room underneath? Leave 150 m of clearance below the base and 250 m above
  // the ground.
  const under = deck.base - 150;
  if (under > groundY + 250) return Math.max(groundY + 250, under);

  // Otherwise climb on top, where a deck is at its best anyway.
  return deck.top + 320;
}
