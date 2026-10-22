'use strict';

// Classes: constructors (and super calls), a getter and setter, a static method, an arrow in
// a class field, a private field, and methods calling each other.

class Shape {
  label = () => this.name.toUpperCase();

  constructor(name) {
    this.name = name;
    this._scale = 1;
  }

  get scale() {
    return this._scale;
  }

  set scale(value) {
    this._scale = value;
  }

  area() {
    return 0;
  }

  describe() {
    return `${this.name}: ${this.area().toFixed(2)}`;
  }

  static compare(a, b) {
    return a.area() - b.area();
  }
}

class Circle extends Shape {
  constructor(radius) {
    super('circle');
    this.radius = radius;
  }

  area() {
    return Math.PI * (this.radius * this.scale) ** 2;
  }
}

class Square extends Shape {
  #side;

  constructor(side) {
    super('square');
    this.#side = side;
  }

  area() {
    return (this.#side * this.scale) ** 2;
  }
}

module.exports = { Shape, Circle, Square };
