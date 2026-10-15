# List/extract the module graph from a Bun single-file executable (ELF .bun section).
# usage: python3 -I bunfs_list.py <binary> [outdir]
import sys,mmap,struct,os,collections
f=open(sys.argv[1],'rb'); m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ)
e_shoff=struct.unpack('<Q',m[0x28:0x30])[0]; e_shentsize,e_shnum,e_shstrndx=struct.unpack('<HHH',m[0x3a:0x40])
def sh(i):
    o=e_shoff+i*e_shentsize; return struct.unpack('<IIQQQQIIQQ',m[o:o+64])
st=sh(e_shstrndx)
for i in range(e_shnum):
    s=sh(i); nm=m[st[4]+s[0]:m.find(b'\0',st[4]+s[0])]
    if nm==b'.bun': off=s[4]
base=off+8; n=struct.unpack('<Q',m[off:off+8])[0]; t=base+n-16
assert m[t:t+16]==b"\n---- Bun! ----\n"
bc,moff,mlen,entry,aoff,alen,flags=struct.unpack('<QIIIIII',m[t-32:t])
REC=52; cnt=mlen//REC
print(f"modules={cnt} entry={entry} byte_count={bc}")
L=lambda p:(p[0],p[1])
mods=[]
for i in range(cnt):
    r=m[base+moff+i*REC: base+moff+(i+1)*REC]
    ptrs=struct.unpack('<12I',r[:48]); tail=r[48:]
    name=m[base+ptrs[0]:base+ptrs[0]+ptrs[1]].decode('utf8','replace')
    mods.append((i,name,ptrs,tail))
kinds=collections.Counter()
for i,name,p,tail in mods:
    ext=os.path.splitext(name)[1]; kinds[ext]+=1
print(kinds.most_common(20))
big=sorted(mods,key=lambda x:-x[2][3])[:25]
for i,name,p,tail in big: print(i,name,'contents',p[3],'srcmap',p[5],'bytecode',p[7],'p5',p[9],'p6',p[11],'tail',tail.hex())
print('entry module:',mods[entry][1], mods[entry][2][3], mods[entry][3].hex())
if len(sys.argv)>2:
    out=sys.argv[2]
    for i,name,p,tail in mods:
        rel=name.split('/$bunfs/root/',1)[-1].lstrip('/') or f'mod{i}'
        dst=os.path.join(out,rel); os.makedirs(os.path.dirname(dst),exist_ok=True)
        open(dst,'wb').write(m[base+p[2]:base+p[2]+p[3]])
        if p[7]: open(dst+'.jsc','wb').write(m[base+p[6]:base+p[6]+p[7]])
    print('extracted to',out)
