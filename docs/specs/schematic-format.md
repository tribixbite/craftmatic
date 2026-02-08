# Sponge Schematic Format v2

Craftmatic reads and writes the Sponge Schematic v2 format (`.schem` files), the standard format used by WorldEdit, FAWE, and other Minecraft tools.

## File Structure

A `.schem` file is a **gzip-compressed NBT compound** with this structure:

```
Schematic (TAG_Compound, root)
├── Version: 2 (TAG_Int)
├── DataVersion: <mc data version> (TAG_Int)
├── Width: <short>
├── Height: <short>
├── Length: <short>
├── Offset: [x, y, z] (TAG_Int_Array, optional)
├── Palette (TAG_Compound)
│   ├── "minecraft:air": 0
│   ├── "minecraft:stone": 1
│   ├── "minecraft:oak_planks": 2
│   └── ... (block state string → palette index)
├── PaletteMax: <int> (number of unique block states)
├── BlockData: <byte_array> (varint-encoded palette indices)
└── BlockEntities (TAG_List of TAG_Compound, optional)
    └── [0] (TAG_Compound)
        ├── Id: "minecraft:chest" (TAG_String)
        ├── Pos: [x, y, z] (TAG_Int_Array)
        └── ... (entity-specific NBT data)
```

## Block Data Encoding

Block data is a flat byte array with **varint-encoded** palette indices, stored in **YZX order**:

```
index = (y * length + z) * width + x
```

### Varint Format
- Each byte uses 7 data bits + 1 continuation bit (MSB)
- Values 0-127: single byte
- Values 128+: multiple bytes, MSB=1 means more bytes follow

## Palette

The palette maps block state strings to integer indices. Block states include properties:

```
minecraft:dark_oak_stairs[facing=north,half=bottom,shape=straight]
minecraft:chest[facing=east,type=single,waterlogged=false]
minecraft:oak_log[axis=y]
```

## Block Entities

Blocks with additional data (chests, signs, barrels, etc.) are stored in the BlockEntities list. Each entry includes:
- `Id`: namespaced block type
- `Pos`: [x, y, z] position within the schematic
- Additional NBT data specific to the entity type

### Chest/Barrel Inventory Format
```
Items (TAG_List)
└── [0] (TAG_Compound)
    ├── Slot: 0 (TAG_Byte)
    ├── id: "minecraft:diamond" (TAG_String)
    └── Count: 64 (TAG_Byte)
```

## Implementation Notes

- **Parsing**: Uses `prismarine-nbt` for robust NBT deserialization
- **Writing**: Custom `NBTWriter` class for precise binary control
- **DataVersion**: Set to 3700 (Minecraft 1.21) by default
- **Compression**: gzip (level 9 for smallest files)
