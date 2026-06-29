# Modutwin

**Modutwin** | A web platform that creates digital twins of building interiors using 3D Gaussian Splatting.  
* [Webite](https://splat.wiki)
* [Demo Video](https://youtu.be/1Raxe9ffwnc)

| Before(Only Corridor) | After(With Rooms) |
|:---:|:---:|
| <img width="360" height="225" alt="복도_정합전" src="https://github.com/user-attachments/assets/e8fc9b88-215e-4698-a335-9e409adb0720" /> | <img width="360" height="225" alt="복도_정합후_9초" src="https://github.com/user-attachments/assets/d17fd1bd-6442-4efa-bb0a-f1a8060a37d7" /> |

## Core Features
Modular Indoor Digital Twins via Door-Based Alignment of 3DGS Assets
- [3DGS asset Refinement](#3DGS-asset-Refinement)
- [Automatic Door Corner Extraction](#Automatic-Door-Corner-Extraction)
- [Automatic Door-Based Alignment](#Automatic-Door-Based-Alignment)
- [Door Interaction (Open & Close)](#Door-Interaction (Open & Close))

<br>  

---

### 3DGS asset Refinement
* Without Refining Indoor 3DGS Assets...
→ Assets OVERLAP!
  | Example | 
  |:---:|
  | <img width="360" height="167" alt="다듬기안한모듈충돌" src="https://github.com/user-attachments/assets/0241528e-8862-481e-83a4-bb05850614b1" /> |
* With Refining
  | Original | After Outer Gaussian Removal | After Boundary Mesh Generation |
  |:---:|:---:|:---:|
  | <img width="1800" height="1008" alt="out_1_cropped" src="https://github.com/user-attachments/assets/caecf60c-edca-4168-b708-e3848e995015" /> | <img width="1800" height="1008" alt="out_2_cropped" src="https://github.com/user-attachments/assets/04ecf586-ba53-481f-87f3-b21918a400e6" /> | <img width="1800" height="1008" alt="out_3_cropped" src="https://github.com/user-attachments/assets/27e81a56-eabc-402e-be83-281bba887ca0" /> |
* After Connecting
  | Screenshot |
  |:---:|
  | <img width="380" height="250" alt="after_connect" src="https://github.com/user-attachments/assets/e4784e9a-f9c3-42de-9383-2fc43e55c989" /> |

---

### Automatic Door Corner Extraction
using SAM3
  | Record |
  |:---:|
  | <img width="480" height="350" alt="sam3" src="https://github.com/user-attachments/assets/f8ea6be1-e007-4226-81c2-78fa3c6b1144" /> |

---

### Automatic Door-Based Alignment
| Record |
|:---:|
| <img width="581" height="350" alt="정합" src="https://github.com/user-attachments/assets/d9cef12e-0b4e-4fda-8e02-9e3c122aa7c4" /> |

---

### Door Interaction (Open & Close)
| Record |
|:---:|
| <img width="800" height="391" alt="door_openclose" src="https://github.com/user-attachments/assets/c13dd2ea-b897-4627-86af-62644e3925d2" /> |

---

### Future Work: Automatic Room Boundary Surface Extraction using PointCloud of Gaussians
- using a PointNet++-based network

| Ceiling & Floor | Walls |
|:---:|:---:|
| <img width="150" height="150" alt="image" src="https://github.com/user-attachments/assets/6f459332-8532-4fc7-8f9a-bd4e6cdaf91a" /> | <img width="150" height="150" alt="image" src="https://github.com/user-attachments/assets/c86a9be7-db51-4542-ada6-3ec6f11fb26d" /> |
