/*
 * DDay Controls — Engineering calculation core.
 *
 * Pure maths, no DOM. Mirrors dday_engineering.py in the Windows suite so both
 * versions of the Engineering Calculator give identical answers.
 *
 * Integer expression work uses BigInt throughout: the JavaScript bitwise
 * operators are fixed at 32 bits, which would silently mangle 64-bit words.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DDayCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==========================================================================
  // BASE EXPRESSION EVALUATOR
  // ==========================================================================
  //
  // Bare literals are read in the currently selected base. Prefixes override
  // it: 0x = hex, 0o = octal, 0b = binary. Because "b" is itself a hex digit,
  // the 0b prefix is NOT honoured while the selected base is HEX — there
  // 0b10 reads as the hex value 0B10.

  const BASE_RADIX = { DEC: 10, HEX: 16, BIN: 2, OCT: 8 };

  const BASE_DIGITS = {
    DEC: '0123456789',
    HEX: '0123456789abcdef',
    BIN: '01',
    OCT: '01234567',
  };

  const BASE_PREFIX = { DEC: '', HEX: '0x', BIN: '0b', OCT: '0o' };

  // Lowest binding first, matching C so results agree with structured text.
  const PRECEDENCE = [['|'], ['^'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

  const PREFIX_BASES = { x: 'HEX', o: 'OCT', b: 'BIN' };

  class CalcError extends Error {
    constructor(message) {
      super(message);
      this.name = 'CalcError';
    }
  }

  function calcBitWidth(text) {
    return { '8-bit': 8, '16-bit': 16, '32-bit': 32, '64-bit': 64 }[text] || 16;
  }

  // Wrap an integer into the given word size and signedness.
  function wrapToWord(value, bits, signed) {
    const width = BigInt(bits);
    const masked = value & ((1n << width) - 1n);
    if (signed && masked >= 1n << (width - 1n)) return masked - (1n << width);
    return masked;
  }

  function isAlnum(ch) {
    return /[0-9a-z]/i.test(ch);
  }

  // Split expression text into number, operator, and parenthesis tokens.
  function tokenizeExpression(text, base) {
    if (!BASE_RADIX[base]) throw new CalcError("Unknown base '" + base + "'.");

    const digits = BASE_DIGITS[base];
    const tokens = [];
    let index = 0;

    while (index < text.length) {
      const char = text[index];

      // Whitespace and digit-group separators carry no meaning.
      if (/\s/.test(char) || char === '_' || char === ',') {
        index += 1;
        continue;
      }

      if (char === '(' || char === ')') {
        tokens.push({ kind: 'paren', value: char });
        index += 1;
        continue;
      }

      const two = text.slice(index, index + 2);
      if (two === '<<' || two === '>>') {
        tokens.push({ kind: 'op', value: two });
        index += 2;
        continue;
      }

      if ('+-*/%&|^~'.indexOf(char) !== -1) {
        tokens.push({ kind: 'op', value: char });
        index += 1;
        continue;
      }

      if (digits.indexOf(char.toLowerCase()) !== -1 || char === '0') {
        let prefix = BASE_PREFIX[base];
        let allowed = digits;

        if (char === '0' && index + 1 < text.length) {
          const marker = text[index + 1].toLowerCase();
          const prefixBase = PREFIX_BASES[marker];
          // "b" is a hex digit, so the 0b prefix is ambiguous in hex mode.
          if (prefixBase && !(base === 'HEX' && marker === 'b')) {
            prefix = BASE_PREFIX[prefixBase];
            allowed = BASE_DIGITS[prefixBase];
            index += 2;
            if (index >= text.length || allowed.indexOf(text[index].toLowerCase()) === -1) {
              throw new CalcError("'0" + marker + "' prefix needs at least one digit.");
            }
          }
        }

        const start = index;
        while (
          index < text.length &&
          (allowed.indexOf(text[index].toLowerCase()) !== -1 || text[index] === '_' || text[index] === ',')
        ) {
          index += 1;
        }

        const literal = text.slice(start, index).replace(/[_,]/g, '');
        if (!literal) throw new CalcError("Invalid number near '" + text.slice(start, start + 6) + "'.");

        // Catch a trailing character that is a digit in some other base —
        // "19" typed while BIN is selected, for example.
        if (index < text.length && isAlnum(text[index])) {
          throw new CalcError("'" + text[index] + "' is not a valid " + base + ' digit.');
        }

        tokens.push({ kind: 'num', value: BigInt(prefix + literal) });
        continue;
      }

      if (isAlnum(char)) throw new CalcError("'" + char + "' is not a valid " + base + ' digit.');
      throw new CalcError("Unexpected character '" + char + "'.");
    }

    return tokens;
  }

  // Recursive-descent parser over the token list.
  function ExpressionParser(tokens, bits, signed) {
    this.tokens = tokens;
    this.position = 0;
    this.bits = bits;
    this.signed = signed;
    this.overflow = false;
  }

  ExpressionParser.prototype.peek = function () {
    return this.position < this.tokens.length ? this.tokens[this.position] : null;
  };

  // Wrap a result, recording whether the word size truncated it.
  ExpressionParser.prototype.wrap = function (value) {
    const wrapped = wrapToWord(value, this.bits, this.signed);
    if (wrapped !== value) this.overflow = true;
    return wrapped;
  };

  ExpressionParser.prototype.parseBinary = function (level) {
    if (level >= PRECEDENCE.length) return this.parseUnary();

    const operators = PRECEDENCE[level];
    let value = this.parseBinary(level + 1);

    for (;;) {
      const token = this.peek();
      if (!token || token.kind !== 'op' || operators.indexOf(token.value) === -1) return value;
      this.position += 1;
      const right = this.parseBinary(level + 1);
      value = this.wrap(this.apply(token.value, value, right));
    }
  };

  ExpressionParser.prototype.apply = function (operator, left, right) {
    switch (operator) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      // BigInt division already truncates toward zero and BigInt remainder
      // already takes the dividend's sign — both match C and IEC 61131.
      case '/':
        if (right === 0n) throw new CalcError('Division by zero.');
        return left / right;
      case '%':
        if (right === 0n) throw new CalcError('Division by zero.');
        return left % right;
      case '&': return left & right;
      case '|': return left | right;
      case '^': return left ^ right;
      case '<<':
      case '>>': {
        if (right < 0n) throw new CalcError('Shift count cannot be negative.');
        // Clamping keeps a huge shift count from allocating a huge integer;
        // every bit has already left the word by then anyway.
        const count = right > BigInt(this.bits) ? BigInt(this.bits) : right;
        return operator === '<<' ? left << count : left >> count;
      }
      default:
        throw new CalcError("Unknown operator '" + operator + "'.");
    }
  };

  ExpressionParser.prototype.parseUnary = function () {
    const token = this.peek();
    if (token && token.kind === 'op' && (token.value === '-' || token.value === '+' || token.value === '~')) {
      this.position += 1;
      const operand = this.parseUnary();
      if (token.value === '-') return this.wrap(-operand);
      if (token.value === '~') return this.wrap(~operand);
      return operand;
    }
    return this.parsePrimary();
  };

  ExpressionParser.prototype.parsePrimary = function () {
    const token = this.peek();
    if (!token) throw new CalcError('Expression ends unexpectedly.');

    if (token.kind === 'num') {
      this.position += 1;
      return this.wrap(token.value);
    }

    if (token.kind === 'paren' && token.value === '(') {
      this.position += 1;
      const value = this.parseBinary(0);
      const closing = this.peek();
      if (!closing || closing.value !== ')') throw new CalcError('Missing closing parenthesis.');
      this.position += 1;
      return value;
    }

    if (token.kind === 'paren') throw new CalcError('Unmatched closing parenthesis.');
    throw new CalcError("Operator '" + token.value + "' is missing a value.");
  };

  // Evaluate an expression in the given base and word size.
  function evaluateExpression(text, base, bits, signed) {
    if (!text.trim()) throw new CalcError('No expression entered.');

    const tokens = tokenizeExpression(text, base);
    if (!tokens.length) throw new CalcError('No expression entered.');

    const parser = new ExpressionParser(tokens, bits, signed);
    const value = parser.parseBinary(0);

    const remaining = parser.peek();
    if (remaining) {
      if (remaining.kind === 'paren') throw new CalcError('Unmatched closing parenthesis.');
      throw new CalcError("Unexpected trailing '" + remaining.value + "'.");
    }

    return { value: value, overflow: parser.overflow };
  }

  // Render a wrapped value in one of the four bases, grouping long binaries.
  function formatInBase(value, base, bits) {
    const width = BigInt(bits);
    const unsigned = value < 0n ? value + (1n << width) : value;

    if (base === 'DEC') return value.toString(10);
    if (base === 'HEX') return unsigned.toString(16).toUpperCase().padStart(bits / 4, '0');
    if (base === 'OCT') return unsigned.toString(8);
    if (base === 'BIN') {
      const bits2 = unsigned.toString(2).padStart(bits, '0');
      return bits > 8 ? (bits2.match(/.{1,8}/g) || []).join(' ') : bits2;
    }
    throw new CalcError("Unknown base '" + base + "'.");
  }

  // ==========================================================================
  // ANALOG SCALING
  // ==========================================================================
  //
  // Raw-count ranges for the analog cards and signal types seen most often on
  // a controls job.

  const ANALOG_RAW_PRESETS = [
    { name: 'Siemens S7 unipolar', low: 0, high: 27648, note: 'Normalized range for 0-10 V or 4-20 mA' },
    { name: 'Siemens S7 bipolar', low: -27648, high: 27648, note: 'Normalized range for ±10 V' },
    { name: 'Allen-Bradley SLC 4-20 mA', low: 3277, high: 16384, note: '1746-NI4 raw counts across 4-20 mA' },
    { name: '12-bit unipolar', low: 0, high: 4095, note: 'Common low-cost analog input' },
    { name: '13-bit unipolar', low: 0, high: 8191, note: '13-bit converter' },
    { name: '14-bit unipolar', low: 0, high: 16383, note: '14-bit converter' },
    { name: '15-bit unipolar', low: 0, high: 32767, note: '15-bit converter' },
    { name: '16-bit unsigned', low: 0, high: 65535, note: 'Full unsigned word' },
    { name: '16-bit signed', low: -32768, high: 32767, note: 'Full signed word' },
    { name: 'Percent', low: 0, high: 100, note: 'Already scaled to percent' },
    { name: '4-20 mA signal', low: 4, high: 20, note: 'Raw milliamps rather than counts' },
    { name: '0-10 V signal', low: 0, high: 10, note: 'Raw volts rather than counts' },
  ];

  // Map a value from one linear range onto another.
  function scaleLinear(value, inLow, inHigh, outLow, outHigh, clamp) {
    if (inLow === inHigh) throw new CalcError('Input range low and high cannot be equal.');

    let scaled = outLow + ((value - inLow) * (outHigh - outLow)) / (inHigh - inLow);

    if (clamp) {
      const low = Math.min(outLow, outHigh);
      const high = Math.max(outLow, outHigh);
      scaled = Math.min(Math.max(scaled, low), high);
    }

    return scaled;
  }

  // Scale a raw count to engineering units with range and resolution detail.
  function scaleAnalog(raw, rawLow, rawHigh, euLow, euHigh, clamp) {
    const eu = scaleLinear(raw, rawLow, rawHigh, euLow, euHigh, clamp);
    const rawSpan = rawHigh - rawLow;
    const euSpan = euHigh - euLow;

    return {
      eu: eu,
      rawSpan: rawSpan,
      euSpan: euSpan,
      // Engineering units represented by a single raw count.
      resolution: rawSpan ? euSpan / rawSpan : NaN,
      percent: scaleLinear(raw, rawLow, rawHigh, 0, 100),
      underRange: raw < Math.min(rawLow, rawHigh),
      overRange: raw > Math.max(rawLow, rawHigh),
    };
  }

  // Scale an engineering value back to the raw count a controller would hold.
  function unscaleAnalog(eu, rawLow, rawHigh, euLow, euHigh, clamp) {
    const raw = scaleLinear(eu, euLow, euHigh, rawLow, rawHigh, clamp);

    return {
      raw: raw,
      rawRounded: Math.round(raw),
      percent: scaleLinear(eu, euLow, euHigh, 0, 100),
      underRange: eu < Math.min(euLow, euHigh),
      overRange: eu > Math.max(euLow, euHigh),
    };
  }

  // ==========================================================================
  // OHM'S LAW AND POWER
  // ==========================================================================

  // Solve the power wheel from any two known quantities.
  function solveOhmsLaw(volts, amps, ohms, watts) {
    const known = [volts, amps, ohms, watts].filter(function (x) {
      return x !== null && x !== undefined;
    });

    if (known.length !== 2) throw new CalcError('Enter exactly two values.');

    let v = volts;
    let i = amps;
    let r = ohms;
    let p = watts;
    const has = function (x) {
      return x !== null && x !== undefined;
    };

    if (has(v) && has(i)) {
      if (i === 0) throw new CalcError('Current cannot be zero when solving for resistance.');
      r = v / i;
      p = v * i;
    } else if (has(v) && has(r)) {
      if (r === 0) throw new CalcError('Resistance cannot be zero when solving for current.');
      i = v / r;
      p = (v * v) / r;
    } else if (has(v) && has(p)) {
      if (v === 0) throw new CalcError('Voltage cannot be zero when solving from power.');
      i = p / v;
      if (p === 0) throw new CalcError('Power cannot be zero when solving for resistance.');
      r = (v * v) / p;
    } else if (has(i) && has(r)) {
      v = i * r;
      p = i * i * r;
    } else if (has(i) && has(p)) {
      if (i === 0) throw new CalcError('Current cannot be zero when solving from power.');
      v = p / i;
      r = p / (i * i);
    } else if (has(r) && has(p)) {
      if (r < 0 || p < 0) throw new CalcError('Resistance and power must be positive.');
      v = Math.sqrt(p * r);
      if (r === 0) throw new CalcError('Resistance cannot be zero when solving for current.');
      i = Math.sqrt(p / r);
    }

    return { volts: v, amps: i, ohms: r, watts: p };
  }

  // ==========================================================================
  // MOTOR, DRIVE AND GEARBOX
  // ==========================================================================

  const WATTS_PER_HP = 745.6998715822702; // Mechanical horsepower
  const FOOT_POUNDS_PER_HP_MINUTE = 33000.0; // Definition of one horsepower
  const NM_PER_LB_FT = 1.3558179483314004;

  // Torque constants derived from P = T * omega rather than rounded off, so
  // the imperial and metric sides of the tool agree with each other.
  const HP_TORQUE_CONSTANT = FOOT_POUNDS_PER_HP_MINUTE / (2 * Math.PI); // ~5252.11
  const KW_TORQUE_CONSTANT = 60000.0 / (2 * Math.PI); // ~9549.30

  function hpToKw(hp) {
    return (hp * WATTS_PER_HP) / 1000.0;
  }

  function kwToHp(kw) {
    return (kw * 1000.0) / WATTS_PER_HP;
  }

  // Return shaft torque in lb-ft and N-m for a power and speed.
  function torqueFromPower(hp, rpm) {
    if (rpm === 0) throw new CalcError('Speed cannot be zero when solving for torque.');
    const kw = hpToKw(hp);
    return {
      kw: kw,
      lbFt: (HP_TORQUE_CONSTANT * hp) / rpm,
      nM: (KW_TORQUE_CONSTANT * kw) / rpm,
    };
  }

  // Return shaft power for a torque in lb-ft and a speed.
  function powerFromTorque(lbFt, rpm) {
    const hp = (lbFt * rpm) / HP_TORQUE_CONSTANT;
    return { hp: hp, kw: hpToKw(hp), nM: lbFt * NM_PER_LB_FT };
  }

  function synchronousSpeed(hertz, poles) {
    if (poles <= 0) throw new CalcError('Pole count must be greater than zero.');
    if (poles % 2) throw new CalcError('Pole count must be even.');
    return (120.0 * hertz) / poles;
  }

  function slipPercent(syncRpm, actualRpm) {
    if (syncRpm === 0) throw new CalcError('Synchronous speed cannot be zero.');
    return ((syncRpm - actualRpm) / syncRpm) * 100.0;
  }

  // Return apparent, real and reactive power for a motor circuit.
  function motorPower(volts, amps, powerFactor, threePhase) {
    if (!(powerFactor >= 0 && powerFactor <= 1)) throw new CalcError('Power factor must be between 0 and 1.');

    const phaseFactor = threePhase ? Math.sqrt(3) : 1;
    const kva = (phaseFactor * volts * amps) / 1000.0;
    const kw = kva * powerFactor;
    const kvar = kva * Math.sqrt(Math.max(0, 1 - powerFactor * powerFactor));

    return { kva: kva, kw: kw, kvar: kvar, hp: kwToHp(kw) };
  }

  // Return full-load current drawn by a motor of a given output rating.
  function fullLoadAmps(hp, volts, powerFactor, efficiency, threePhase) {
    if (volts === 0) throw new CalcError('Voltage cannot be zero.');
    if (!(powerFactor > 0 && powerFactor <= 1)) throw new CalcError('Power factor must be between 0 and 1.');
    if (!(efficiency > 0 && efficiency <= 1)) throw new CalcError('Efficiency must be between 0 and 1.');

    const phaseFactor = threePhase ? Math.sqrt(3) : 1;
    return (hp * WATTS_PER_HP) / (phaseFactor * volts * powerFactor * efficiency);
  }

  // Return gearbox output speed and torque for a reduction ratio.
  function gearboxOutput(inputRpm, ratio, inputTorque, efficiency) {
    if (ratio === 0) throw new CalcError('Gear ratio cannot be zero.');
    if (!(efficiency > 0 && efficiency <= 1)) throw new CalcError('Efficiency must be between 0 and 1.');

    return {
      outputRpm: inputRpm / ratio,
      outputTorque: (inputTorque || 0) * ratio * efficiency,
    };
  }

  // ==========================================================================
  // ENCODER AND MOTION
  // ==========================================================================

  const MECHANISM_LEADSCREW = 'Leadscrew / belt pitch';
  const MECHANISM_PULLEY = 'Pulley / roller diameter';
  const MECHANISM_ROTARY = 'Rotary (degrees)';

  // Return travel produced by one revolution of the driven mechanism.
  function travelPerRevolution(mechanism, dimension) {
    if (mechanism === MECHANISM_LEADSCREW) return dimension;
    if (mechanism === MECHANISM_PULLEY) return Math.PI * dimension;
    if (mechanism === MECHANISM_ROTARY) return 360.0;
    throw new CalcError("Unknown mechanism '" + mechanism + "'.");
  }

  // Return encoder resolution and travel figures for a drive train.
  function encoderResolution(ppr, quadrature, mechanism, dimension, gearRatio) {
    const ratio = gearRatio === undefined || gearRatio === null ? 1 : gearRatio;

    if (!(ppr > 0)) throw new CalcError('Pulses per revolution must be greater than zero.');
    if ([1, 2, 4].indexOf(quadrature) === -1) throw new CalcError('Quadrature multiplier must be 1, 2 or 4.');
    if (!(ratio > 0)) throw new CalcError('Gear ratio must be greater than zero.');

    const counts = ppr * quadrature;
    // The gearbox sits between encoder and load, so the load moves less per
    // encoder revolution by exactly the reduction ratio.
    const travel = travelPerRevolution(mechanism, dimension) / ratio;

    return {
      countsPerRev: counts,
      travelPerRev: travel,
      distancePerCount: travel / counts,
      countsPerUnit: travel ? counts / travel : NaN,
    };
  }

  function countsForDistance(distance, distancePerCount) {
    if (distancePerCount === 0) throw new CalcError('Distance per count cannot be zero.');
    return distance / distancePerCount;
  }

  function pulseFrequency(countsPerRev, rpm) {
    return (countsPerRev * rpm) / 60.0;
  }

  // ==========================================================================
  // NUMBER FORMATTING
  // ==========================================================================

  // Drop trailing zeros from a decimal string, and the bare point with them.
  function trimZeros(text) {
    if (text.indexOf('.') === -1) return text;
    return text.replace(/0+$/, '').replace(/\.$/, '');
  }

  // Format a calculated number to a fixed number of significant digits.
  //
  // Significant digits rather than decimal places: a resolution of 0.0012207
  // and a frequency of 204800 both want to stay readable, and a fixed number
  // of decimals cannot do both. toPrecision switches to exponential on the
  // same rule as Python's "g", so both builds of the tool agree.
  function formatNumber(value, significant) {
    const digits = significant === undefined ? 7 : significant;

    if (value === null || value === undefined) return '';
    if (Number.isNaN(value)) return '—';
    if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
    if (value === 0) return '0';

    const text = value.toPrecision(digits);
    const exponent = text.indexOf('e');
    if (exponent === -1) return trimZeros(text);

    // Trim the mantissa but keep the exponent: 1.500000e+12 -> 1.5e+12
    return trimZeros(text.slice(0, exponent)) + text.slice(exponent);
  }

  return {
    CalcError: CalcError,
    BASE_RADIX: BASE_RADIX,
    calcBitWidth: calcBitWidth,
    wrapToWord: wrapToWord,
    tokenizeExpression: tokenizeExpression,
    evaluateExpression: evaluateExpression,
    formatInBase: formatInBase,
    ANALOG_RAW_PRESETS: ANALOG_RAW_PRESETS,
    scaleLinear: scaleLinear,
    scaleAnalog: scaleAnalog,
    unscaleAnalog: unscaleAnalog,
    solveOhmsLaw: solveOhmsLaw,
    WATTS_PER_HP: WATTS_PER_HP,
    HP_TORQUE_CONSTANT: HP_TORQUE_CONSTANT,
    KW_TORQUE_CONSTANT: KW_TORQUE_CONSTANT,
    NM_PER_LB_FT: NM_PER_LB_FT,
    hpToKw: hpToKw,
    kwToHp: kwToHp,
    torqueFromPower: torqueFromPower,
    powerFromTorque: powerFromTorque,
    synchronousSpeed: synchronousSpeed,
    slipPercent: slipPercent,
    motorPower: motorPower,
    fullLoadAmps: fullLoadAmps,
    gearboxOutput: gearboxOutput,
    MECHANISM_LEADSCREW: MECHANISM_LEADSCREW,
    MECHANISM_PULLEY: MECHANISM_PULLEY,
    MECHANISM_ROTARY: MECHANISM_ROTARY,
    travelPerRevolution: travelPerRevolution,
    encoderResolution: encoderResolution,
    countsForDistance: countsForDistance,
    pulseFrequency: pulseFrequency,
    formatNumber: formatNumber,
  };
});
