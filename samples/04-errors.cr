# Error handling without exceptions.
#
# `raise`/`rescue` do not work on the wasm target: raising traps the module with
# `unreachable`, because there is no unwinder to run the handlers. So this sample
# stays on the other side of Crystal's error handling — `null`-returning methods
# and union types. See FINDINGS.md § "Exceptions trap".
#
# A `nil`-returning method instead of an exception.
def parse_int(text : String) : Int32?
  text.strip.to_i?
end

[{"twelve", "12"}, {"nope", "x"}, {"zero", "0"}].each do |(label, text)|
  case value = parse_int(text)
  when Nil
    puts "#{label.ljust(6)} -> not a number"
  else
    puts "#{label.ljust(6)} -> #{value} (doubled: #{value * 2})"
  end
end

# Safe indexing: an out-of-range subscript is nil, not a raise.
numbers = [10, 20, 30]
[0, 2, 5].each do |index|
  number = numbers[index]?
  puts "numbers[#{index}] = #{number.nil? ? "out of range" : number}"
end

# A union type makes the "might not be there" part of the type, so the compiler
# will not let you forget it.
def first_word(text : String) : String?
  text.split.first?
end

["crystal is fun", ""].each do |text|
  word = first_word(text)
  puts "first word of #{text.inspect}: #{word ? word.upcase : "(none)"}"
end
