# Classes, structs, modules, operator overloading and method overloading.
module Greeter
  def greet(name : String) : String
    "Hello, #{name}!"
  end
end

struct Point
  getter x : Float64
  getter y : Float64

  def initialize(@x : Float64, @y : Float64)
  end

  def +(other : Point) : Point
    Point.new(x + other.x, y + other.y)
  end

  def length : Float64
    Math.sqrt(x ** 2 + y ** 2)
  end

  def to_s(io : IO) : Nil
    io << "(#{x}, #{y})"
  end
end

class Counter
  include Greeter

  @count : Int32 = 0

  def initialize(@name : String)
  end

  def tick : Int32
    @count += 1
  end

  def to_s(io : IO) : Nil
    io << "#{@name}: #{@count}"
  end
end

# Two methods, same name, different argument types.
def describe(value : Int32) : String
  "Int32 #{value}"
end

def describe(value : String) : String
  "String #{value.inspect}"
end

a = Point.new(1.5, 2.0)
b = Point.new(3.0, 4.5)

puts "a         = #{a}"
puts "b         = #{b}"
puts "a + b     = #{a + b}"
puts "|a + b|   = #{(a + b).length.round(3)}"

counter = Counter.new("ticker")
3.times { counter.tick }
puts counter
puts counter.greet("Crystal")
puts describe(42)
puts describe("forty-two")
