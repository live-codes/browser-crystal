# Arrays, hashes, blocks and the Enumerable methods Crystal takes from Ruby.
fruits = %w[pear apple fig banana cherry]

puts "all:        #{fruits}"
puts "sorted:     #{fruits.sort}"
puts "by length:  #{fruits.sort_by(&.size)}"
puts "over four:  #{fruits.select { |fruit| fruit.size > 4 }.join(", ")}"
puts "lengths:    #{fruits.map(&.size)}"
puts "total:      #{fruits.sum(&.size)}"

counts = Hash(String, Int32).new(0)
"the quick brown fox jumps over the lazy dog".each_char do |char|
  counts[char.to_s] += 1 unless char == ' '
end

top = counts.to_a.sort_by { |(_letter, count)| -count }.first(3)
puts "top letters: #{top.map { |(letter, count)| "#{letter}=#{count}" }.join(", ")}"

squares = (1..6).map { |n| n * n }
puts "squares:    #{squares}"
puts "evens:      #{squares.select(&.even?)}"
puts "sum:        #{squares.sum}"
