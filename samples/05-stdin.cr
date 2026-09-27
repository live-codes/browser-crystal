# Reads stdin, which on this target is a WASI fd_read — so the page's stdin box
# is what feeds it.
print "how many numbers? "
count = gets.try(&.to_i?) || 0
puts "reading #{count} of them"

total = 0
count.times do
  line = gets
  break unless line
  total += line.to_i
end

puts "sum:     #{total}"
puts "average: #{count.zero? ? 0.0 : (total / count.to_f).round(2)}"
