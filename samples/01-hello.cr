# Strings, interpolation, ranges — the smallest useful thing.
puts "hello from Crystal, running in your browser"
puts "compiled by Crystal #{Crystal::VERSION}"

1.upto(5) do |n|
  puts "#{n} squared is #{n * n}"
end

words = %w[crystal runs in the browser]
puts "sorted: #{words.sort.join(' ')}"
puts "range sum: #{(1..100).sum}"
