// Hardware instancing for RawShaderMaterial, which is the only kind this
// renderer has.
//
// three.js injects nothing into a RawShaderMaterial: no `instanceMatrix`
// attribute declaration, no `#ifdef USE_INSTANCING` block, no automatic
// bounding-sphere maths. So this file is the whole of the instancing support,
// and it is deliberately generic rather than tree-shaped: the cars on the
// roadmap want the same thing, and a second copy is how the two would drift.
//
// **Per-instance vec4s, not a mat4.** A mat4 per instance is 64 bytes and four
// attribute slots to describe a rigid transform with one axis of rotation. A
// tree, a parked car and a street lamp all stand upright on the ground, so
// position, yaw and a scale is the complete transform, and it fits in two vec4s
// with room left for the per-instance colour and shape jitter that stop a field
// of instances reading as one asset repeated. At 60k instances that is 1.9 MB
// instead of 15 MB, and it is the difference between one buffer update per
// recentre and four.
//
// **Capacity is fixed, count is not.** The instanced attributes are allocated
// once at their maximum and `geometry.instanceCount` is what moves, because a
// field that rebuilds around a moving camera would otherwise reallocate a GPU
// buffer every few seconds.

import * as THREE from "three";

/** One per-instance attribute: a name the shader declares, and its width. */
export interface InstanceAttribute {
  name: string;
  itemSize: number;
}

/**
 * A base mesh plus a fixed pool of per-instance attributes.
 *
 * `arrays` are the CPU-side buffers to write into; call `upload(count)` once
 * they hold `count` instances.
 */
export class InstancedField {
  readonly geometry: THREE.InstancedBufferGeometry;
  /** CPU side of each instanced attribute, by name. */
  readonly arrays: Record<string, Float32Array> = {};
  readonly capacity: number;

  private readonly attributes: Record<string, THREE.InstancedBufferAttribute> = {};
  /** Geometries sharing this field's instances, so instanceCount stays in step. */
  private readonly derived: THREE.InstancedBufferGeometry[] = [];

  constructor(base: THREE.BufferGeometry, capacity: number, attrs: readonly InstanceAttribute[]) {
    this.capacity = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    for (const name of Object.keys(base.attributes)) {
      geo.setAttribute(name, base.attributes[name]);
    }
    for (const a of attrs) {
      const array = new Float32Array(capacity * a.itemSize);
      const attr = new THREE.InstancedBufferAttribute(array, a.itemSize);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(a.name, attr);
      this.arrays[a.name] = array;
      this.attributes[a.name] = attr;
    }
    geo.instanceCount = 0;
    // The instances are scattered over kilometres and their positions live in
    // an attribute, so three cannot compute a bounding sphere for them and the
    // one it would infer from the base mesh is a few metres across at the
    // origin. Frustum culling has to be off, and the mesh is one draw call
    // either way: the vertex shader is what culls, by collapsing an instance
    // past the fade distance to a degenerate triangle.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry = geo;
  }

  /**
   * A SECOND geometry over the same instances, with different base geometry.
   *
   * This is how a level of detail is done here. The instance data -- where the
   * cars are, which way they face, what colour they are -- is identical for
   * every level, and duplicating it would double the buffer and guarantee the
   * two copies drift. So the instanced attributes are shared by reference and
   * only the base mesh differs; which of the two actually draws an instance is
   * the vertex shader's business, from the instance's own distance.
   */
  derive(base: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    for (const name of Object.keys(base.attributes)) geo.setAttribute(name, base.attributes[name]);
    for (const name of Object.keys(this.attributes)) geo.setAttribute(name, this.attributes[name]);
    geo.instanceCount = this.geometry.instanceCount;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.derived.push(geo);
    return geo;
  }

  /** Publish the first `count` instances of every array to the GPU. */
  upload(count: number): void {
    const n = Math.min(count, this.capacity);
    for (const name of Object.keys(this.attributes)) {
      const attr = this.attributes[name];
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.geometry.instanceCount = n;
    for (const g of this.derived) g.instanceCount = n;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const g of this.derived) g.dispose();
  }
}

/**
 * The vertex-shader half: one upright instance transform, shared by everything
 * that uses this file so there is one definition of what a per-instance vec4
 * means.
 *
 * `origin` is where the instance stands in world metres, `yaw` its rotation
 * about +y, `scale` its per-axis size. Yaw only, because everything this
 * renderer instances stands on the ground; a full rotation would be a
 * quaternion attribute and nine more ALU per vertex for an axis nothing tilts
 * about.
 */
export const INSTANCE_GLSL = /* glsl */ `
/**
 * The yawCS parameter is (cos yaw, sin yaw), already evaluated.
 *
 * The overloads below take the angle instead and are the ones to reach for
 * first. Take this one when a vertex shader needs the instance's rotation more
 * than once -- to place the vertex, to rotate its normal, to point something
 * else in the instance's own direction -- because a transcendental pair per
 * vertex per use is a real cost on a field of tens of thousands of instances
 * and no compiler will hoist it out of a per-vertex expression for you.
 */
vec3 instanceToWorld(vec3 local, vec3 origin, vec2 yawCS, vec3 scale) {
  vec3 s = local * scale;
  return origin + vec3(yawCS.x * s.x + yawCS.y * s.z, s.y, -yawCS.y * s.x + yawCS.x * s.z);
}

/** The same rotation applied to a direction, for normals. Yaw is orthonormal,
 *  so this is the inverse transpose as well and needs no correction. */
vec3 instanceRotate(vec3 v, vec2 yawCS) {
  return vec3(yawCS.x * v.x + yawCS.y * v.z, v.y, -yawCS.y * v.x + yawCS.x * v.z);
}

vec3 instanceToWorld(vec3 local, vec3 origin, float yaw, vec3 scale) {
  return instanceToWorld(local, origin, vec2(cos(yaw), sin(yaw)), scale);
}

vec3 instanceRotate(vec3 v, float yaw) {
  return instanceRotate(v, vec2(cos(yaw), sin(yaw)));
}

/**
 * Where a collapsed instance is sent.
 *
 * All of its vertices land on the same clip-space point, so every triangle is
 * degenerate and the rasteriser drops it before it costs a fragment. It is
 * outside the clip volume as well, which is belt and braces: a driver that
 * rasterises zero-area triangles still has nothing to do here.
 */
const vec4 INSTANCE_CULLED = vec4(2.0, 2.0, 2.0, 1.0);
`;
