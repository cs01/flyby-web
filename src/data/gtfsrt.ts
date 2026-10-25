// A GTFS-realtime decoder for exactly the fields the transit layer reads.
//
// The feeds (MTA subway, BART, NYC Ferry) are protobuf. A general protobuf
// runtime plus the generated gtfs-realtime bindings is ~90 kB of script for a
// format that is five nested messages deep; this is a wire-format walker that
// keeps trip, stop time and position fields and skips everything else,
// including MTA's NYCT extension (field 1001), by wire type.
//
// Pure: bytes in, plain objects out. test/transit.check.ts decodes a saved
// feed with it.

export interface StopTimeUpdate {
  stopId: string;
  /** Epoch seconds, or null when the feed sends only a delay. */
  arrival: number | null;
  departure: number | null;
  /** Seconds late against the schedule, when the feed says so instead. */
  arrivalDelay: number | null;
  departureDelay: number | null;
  stopSequence: number | null;
  /** 1 SKIPPED, 2 NO_DATA; 0 SCHEDULED. */
  rel: number;
}

export interface TripDescriptor {
  tripId: string;
  routeId: string;
  startDate: string;
  startTime: string;
  directionId: number | null;
}

export interface TripUpdateMsg {
  trip: TripDescriptor;
  stops: StopTimeUpdate[];
  vehicleId: string;
  timestamp: number | null;
}

export interface VehiclePositionMsg {
  trip: TripDescriptor | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  /** Metres per second, as the spec defines it. */
  speed: number | null;
  timestamp: number | null;
  stopId: string;
  /** 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO. */
  status: number | null;
  vehicleId: string;
  vehicleLabel: string;
}

export interface FeedMsg {
  /** Epoch seconds the feed was produced. */
  timestamp: number;
  tripUpdates: TripUpdateMsg[];
  vehicles: VehiclePositionMsg[];
}

const utf8 = new TextDecoder();

/** A cursor over one message's bytes. */
class Reader {
  pos: number;
  constructor(readonly buf: Uint8Array, start: number, readonly end: number) {
    this.pos = start;
  }

  /**
   * Varint as a double. Timestamps are 31 bits and stop sequences small, so
   * the 53-bit mantissa is exact for every field this reads; a negative int32
   * (a delay) arrives as a 10-byte two's-complement varint and is folded back
   * by `int32()`.
   */
  varint(): number {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (this.pos >= this.end) throw new Error("gtfs-rt: truncated varint");
      const b = this.buf[this.pos++];
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
      if (mul > 2 ** 70) throw new Error("gtfs-rt: varint too long");
    }
  }

  int32(): number {
    const v = this.varint();
    return v >= 2 ** 31 ? (v % 2 ** 32) - 2 ** 32 : v;
  }

  float(): number {
    if (this.pos + 4 > this.end) throw new Error("gtfs-rt: truncated fixed32");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }

  /** The [start, end) of a length-delimited field. */
  sub(): [number, number] {
    const n = this.varint();
    const s = this.pos;
    if (s + n > this.end) throw new Error("gtfs-rt: truncated field");
    this.pos = s + n;
    return [s, s + n];
  }

  string(): string {
    const [s, e] = this.sub();
    return utf8.decode(this.buf.subarray(s, e));
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.sub();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`gtfs-rt: wire type ${wire}`);
    if (this.pos > this.end) throw new Error("gtfs-rt: truncated skip");
  }

  /** Calls `f(field, wire)` for every field; `f` must consume it or return false to skip. */
  fields(f: (field: number, wire: number) => boolean): void {
    while (this.pos < this.end) {
      const key = this.varint();
      const field = Math.floor(key / 8);
      const wire = key & 7;
      if (!f(field, wire)) this.skip(wire);
    }
  }

  child(): Reader {
    const [s, e] = this.sub();
    return new Reader(this.buf, s, e);
  }
}

function tripDescriptor(r: Reader): TripDescriptor {
  const t: TripDescriptor = { tripId: "", routeId: "", startDate: "", startTime: "", directionId: null };
  r.fields((f, w) => {
    if (w === 2 && f === 1) t.tripId = r.string();
    else if (w === 2 && f === 2) t.startTime = r.string();
    else if (w === 2 && f === 3) t.startDate = r.string();
    else if (w === 2 && f === 5) t.routeId = r.string();
    else if (w === 0 && f === 6) t.directionId = r.varint();
    else return false;
    return true;
  });
  return t;
}

function stopTimeEvent(r: Reader): { delay: number | null; time: number | null } {
  const e = { delay: null as number | null, time: null as number | null };
  r.fields((f, w) => {
    if (w !== 0) return false;
    if (f === 1) e.delay = r.int32();
    else if (f === 2) e.time = r.varint() || null;
    else return false;
    return true;
  });
  return e;
}

function stopTimeUpdate(r: Reader): StopTimeUpdate {
  const u: StopTimeUpdate = {
    stopId: "", arrival: null, departure: null, arrivalDelay: null, departureDelay: null, stopSequence: null, rel: 0,
  };
  r.fields((f, w) => {
    if (w === 0 && f === 1) u.stopSequence = r.varint();
    else if (w === 2 && f === 2) {
      const e = stopTimeEvent(r.child());
      u.arrival = e.time;
      u.arrivalDelay = e.delay;
    } else if (w === 2 && f === 3) {
      const e = stopTimeEvent(r.child());
      u.departure = e.time;
      u.departureDelay = e.delay;
    } else if (w === 2 && f === 4) u.stopId = r.string();
    else if (w === 0 && f === 5) u.rel = r.varint();
    else return false;
    return true;
  });
  return u;
}

function vehicleDescriptor(r: Reader): { id: string; label: string } {
  const v = { id: "", label: "" };
  r.fields((f, w) => {
    if (w === 2 && f === 1) v.id = r.string();
    else if (w === 2 && f === 2) v.label = r.string();
    else return false;
    return true;
  });
  return v;
}

function tripUpdate(r: Reader): TripUpdateMsg {
  const t: TripUpdateMsg = {
    trip: { tripId: "", routeId: "", startDate: "", startTime: "", directionId: null },
    stops: [],
    vehicleId: "",
    timestamp: null,
  };
  r.fields((f, w) => {
    if (w === 2 && f === 1) t.trip = tripDescriptor(r.child());
    else if (w === 2 && f === 2) t.stops.push(stopTimeUpdate(r.child()));
    else if (w === 2 && f === 3) t.vehicleId = vehicleDescriptor(r.child()).id;
    else if (w === 0 && f === 4) t.timestamp = r.varint();
    else return false;
    return true;
  });
  return t;
}

function vehiclePosition(r: Reader): VehiclePositionMsg {
  const v: VehiclePositionMsg = {
    trip: null, lat: null, lon: null, bearing: null, speed: null, timestamp: null, stopId: "", status: null,
    vehicleId: "", vehicleLabel: "",
  };
  r.fields((f, w) => {
    if (w === 2 && f === 1) v.trip = tripDescriptor(r.child());
    else if (w === 2 && f === 2) {
      const p = r.child();
      p.fields((pf, pw) => {
        if (pw !== 5) return false;
        const x = p.float();
        if (pf === 1) v.lat = x;
        else if (pf === 2) v.lon = x;
        else if (pf === 3) v.bearing = x;
        else if (pf === 5) v.speed = x;
        return true;
      });
    } else if (w === 0 && f === 4) v.status = r.varint();
    else if (w === 0 && f === 5) v.timestamp = r.varint();
    else if (w === 2 && f === 7) v.stopId = r.string();
    else if (w === 2 && f === 8) {
      const d = vehicleDescriptor(r.child());
      v.vehicleId = d.id;
      v.vehicleLabel = d.label;
    } else return false;
    return true;
  });
  return v;
}

/** Decodes a FeedMessage. Throws on bytes that are not one. */
export function decodeFeed(buf: Uint8Array): FeedMsg {
  const out: FeedMsg = { timestamp: 0, tripUpdates: [], vehicles: [] };
  const r = new Reader(buf, 0, buf.length);
  let sawHeader = false;
  r.fields((f, w) => {
    if (w === 2 && f === 1) {
      sawHeader = true;
      const h = r.child();
      h.fields((hf, hw) => {
        if (hw === 0 && hf === 3) {
          out.timestamp = h.varint();
          return true;
        }
        return false;
      });
    } else if (w === 2 && f === 2) {
      const e = r.child();
      e.fields((ef, ew) => {
        if (ew === 2 && ef === 3) out.tripUpdates.push(tripUpdate(e.child()));
        else if (ew === 2 && ef === 4) out.vehicles.push(vehiclePosition(e.child()));
        else return false;
        return true;
      });
    } else return false;
    return true;
  });
  // Every GTFS-rt feed starts with a header; an HTML error page decodes as
  // garbage fields and no header, and must not read as an empty feed.
  if (!sawHeader) throw new Error("gtfs-rt: no header");
  return out;
}
