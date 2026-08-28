// The aircraft: an arcade flight model that the weather actually acts on.
//
// Arcade, not a simulator. It is coordinated and self-stabilising -- roll into
// a turn and it holds the bank, let go and it rolls level -- because the point
// is sightseeing, not managing an aeroplane. What it does NOT do is fake the
// air: wind, turbulence and density altitude come from the observation, so a
// gusty day genuinely shoves the aircraft around and a hot high afternoon
// genuinely climbs worse.
//
// The distinction that matters is between AIRSPEED and GROUNDSPEED. The model
// flies through a moving block of air: thrust and lift act on airspeed, but the
// aircraft's position advances by airspeed PLUS the wind vector. That single
// piece of honesty gives you drift, crab angle, and a downwind leg that eats
// the ground while the airspeed indicator never moves -- all for free, and none
// of it is possible if you just add wind to the velocity you display.

import * as THREE from "three";
import type { Weather } from "../data/weather";

const DEG = Math.PI / 180;

export interface AircraftInput {
  /** -1..1, nose down .. nose up. */
  pitch: number;
  /** -1..1, roll left .. roll right. */
  roll: number;
  /** -1..1, rudder. */
  yaw: number;
  /** 0..1. */
  throttle: number;
}

export interface AircraftConfig {
  /** Metres per second, level, full throttle, at sea level. */
  cruiseSpeed: number;
  minSpeed: number;
  maxSpeed: number;
  /** Degrees per second at full deflection. */
  rollRate: number;
  pitchRate: number;
  /** True for the one-axis mode kids can fly. */
  simple: boolean;
}

export const DEFAULT_CONFIG: AircraftConfig = {
  cruiseSpeed: 92,
  minSpeed: 34,
  maxSpeed: 165,
  rollRate: 75,
  pitchRate: 38,
  simple: false,
};

export class Aircraft {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly config: AircraftConfig;

  /** Speed through the AIR, m/s. What the aircraft's physics see. */
  airspeed: number;
  /** Velocity over the GROUND, m/s. Airspeed plus wind. What the map sees. */
  readonly groundVelocity = new THREE.Vector3();

  throttle = 0.75;
  private bank = 0;
  private pitchAngle = 0;
  private heading = 0;
  private turbPhase = Math.random() * 1000;

  /** Set from the weather each frame. */
  private wind = new THREE.Vector3();
  private gustiness = 0;
  private densityRatio = 1;

  constructor(config: AircraftConfig = DEFAULT_CONFIG) {
    this.config = { ...config };
    this.airspeed = config.cruiseSpeed;
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
    const pressure = wx.pressureHpa * Math.pow(1 - (0.0065 * altitudeM) / (wx.tempC + 273.15), 5.256);
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
    this.airspeed = this.config.cruiseSpeed;
    this.syncQuaternion();
  }

  private syncQuaternion(): void {
    // Heading about +y, then pitch, then bank. Applied in that order so bank is
    // about the aircraft's own longitudinal axis rather than the world's.
    const e = new THREE.Euler(this.pitchAngle, this.heading, this.bank, "YXZ");
    this.quaternion.setFromEuler(e);
  }

  get headingDeg(): number {
    return ((-this.heading / DEG) % 360 + 360) % 360;
  }

  get bankDeg(): number {
    return this.bank / DEG;
  }

  get groundSpeed(): number {
    return this.groundVelocity.length();
  }

  update(input: AircraftInput, dt: number, groundY: number): void {
    const c = this.config;

    // --- Attitude -------------------------------------------------------
    const rollCmd = c.simple ? 0 : input.roll;
    this.bank += rollCmd * c.rollRate * DEG * dt;
    // Self-levelling: with the stick centred the aircraft rolls wings level.
    if (Math.abs(rollCmd) < 0.02) this.bank *= Math.pow(0.16, dt);
    this.bank = THREE.MathUtils.clamp(this.bank, -70 * DEG, 70 * DEG);

    this.pitchAngle += input.pitch * c.pitchRate * DEG * dt;
    if (Math.abs(input.pitch) < 0.02) this.pitchAngle *= Math.pow(0.35, dt);
    this.pitchAngle = THREE.MathUtils.clamp(this.pitchAngle, -35 * DEG, 40 * DEG);

    // A banked aircraft turns. This is the whole of the turn model, and it is
    // the real relation: rate = g * tan(bank) / V, so a steep turn at low speed
    // comes round fast and the same bank at high speed does not.
    const turnRate = (9.81 * Math.tan(this.bank)) / Math.max(this.airspeed, 20);
    this.heading -= turnRate * dt;
    // Rudder is a small direct yaw, mostly for lining up on a landmark.
    this.heading -= input.yaw * 22 * DEG * dt;

    // --- Speed ----------------------------------------------------------
    this.throttle = THREE.MathUtils.clamp(input.throttle, 0, 1);
    const targetSpeed = THREE.MathUtils.lerp(c.minSpeed * 1.15, c.maxSpeed, this.throttle) * this.densityRatio;
    // Climbing costs speed, descending gains it. Energy, roughly.
    const gravityTerm = -Math.sin(this.pitchAngle) * 9.81 * 1.4;
    this.airspeed += ((targetSpeed - this.airspeed) * 0.55 + gravityTerm) * dt;
    this.airspeed = THREE.MathUtils.clamp(this.airspeed, c.minSpeed * 0.7, c.maxSpeed * 1.15);

    // --- Turbulence -----------------------------------------------------
    // Gusts are the difference between the reported wind and the reported gust.
    // A calm day is glassy; a 25 kt gust spread makes the aircraft work.
    this.turbPhase += dt;
    let bumpY = 0;
    if (this.gustiness > 0.3) {
      const g = this.gustiness;
      bumpY = Math.sin(this.turbPhase * 2.7) * Math.sin(this.turbPhase * 0.9 + 1.3) * g * 0.35;
      this.bank += Math.sin(this.turbPhase * 1.7 + 0.7) * g * 0.0055 * dt * 60;
      this.pitchAngle += Math.sin(this.turbPhase * 2.1) * g * 0.0022 * dt * 60;
    }

    this.syncQuaternion();

    // --- Integrate ------------------------------------------------------
    // Airspeed vector in world axes, from the aircraft's own attitude.
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
    const air = forward.multiplyScalar(this.airspeed);
    air.y += bumpY;

    // Ground velocity is airspeed PLUS wind. This is what makes drift real.
    this.groundVelocity.copy(air).add(this.wind);
    this.position.addScaledVector(this.groundVelocity, dt);

    // --- Ground -----------------------------------------------------------
    // A hard floor rather than a crash: this is a sightseeing app, and ending
    // the flight because someone flew into a hill is a bad trade.
    const floor = groundY + 25;
    if (this.position.y < floor) {
      this.position.y = floor;
      if (this.pitchAngle < 0) this.pitchAngle *= 0.4;
    }
    if (this.position.y > 12000) this.position.y = 12000;
  }
}
