const fs = require('fs');
const text = fs.readFileSync('tmp.js');
let open = 0;
for (let i = 0; i < text.length; i++) {
  if (text[i] === 96) {
    open ^= 1;
    console.log(open ? 'open at ' + i : 'close at ' + i);
  }
}
console.log('final open', open);
