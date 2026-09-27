# Regex needs PCRE, which is a separate wasm build. Included on purpose: it is
# the clearest example of a stdlib corner that does not link against wasi-libc
# alone. See FINDINGS.md.
text = "the quick brown fox jumps over the lazy dog"

five_letters = text.scan(/\b\w{5}\b/).map(&.[0])
puts "five-letter words: #{five_letters.join(", ")}"

digits = "abc123def456ghi".scan(/\d+/).map(&.[0])
puts "digit runs:        #{digits.join(", ")}"

puts "hashed:            #{text.gsub(/\s+/, "-")}"
